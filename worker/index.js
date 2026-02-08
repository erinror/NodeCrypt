import { generateClientId, encryptMessage, decryptMessage, logEvent, isString, isObject, getTime } from './utils.js';

// Nginx 伪装模板
const NGINX_TEMPLATE = `<!DOCTYPE html>
<html>
<head>
<title>Welcome to nginx!</title>
<style>
    body { width: 35em; margin: 0 auto; font-family: Tahoma, Verdana, Arial, sans-serif; }
</style>
</head>
<body>
<h1>Welcome to nginx!</h1>
<p>If you see this page, the nginx web server is successfully installed and working. Further configuration is required.</p>
<p>For online documentation and support please refer to <a href="http://nginx.org/">nginx.org</a>.<br/>
Commercial support is available at <a href="http://nginx.com/">nginx.com</a>.</p>
<p><em>Thank you for using nginx.</em></p>
</body>
</html>`;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cookie = request.headers.get('Cookie') || "";

    // === 0. 路径规范化 ===
    if (url.pathname === '/admin/' || url.pathname === '/join/') {
        return Response.redirect(`${url.origin}${url.pathname.slice(0, -1)}`, 301);
    }

    // === API: 验证邀请码 ===
    if (url.pathname === '/api/verify-invite') {
        const { code } = await request.json();
        const id = env.CHAT_ROOM.idFromName('chat-room');
        const stub = env.CHAT_ROOM.get(id);
        
        const res = await stub.fetch(new Request(`${url.origin}/internal/verify-invite`, {
            method: 'POST',
            body: JSON.stringify({ code })
        }));
        
        if (res.ok) {
            const data = await res.json();
            const headers = new Headers();
            // 设置 Cookie
            headers.append('Set-Cookie', `auth=${data.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`);
            // 返回房间信息给前端
            return new Response(JSON.stringify({ 
                ok: true, 
                room: data.room,
                needPwd: data.needPwd 
            }), { headers });
        }
        return new Response(JSON.stringify({ ok: false, error: '无效链接或已过期' }), { status: 403 });
    }

    // === API: 管理员登录 ===
    if (url.pathname === '/api/login') {
        const body = await request.json();
        if (body.pwd === env.PWD) {
            const headers = new Headers();
            const adminToken = await generateToken(env.PWD, 'admin');
            headers.append('Set-Cookie', `auth=${adminToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
            return new Response(JSON.stringify({ ok: true, isAdmin: true }), { headers });
        }
        return new Response(JSON.stringify({ ok: false }), { status: 401 });
    }

    // === API: 生成邀请链接 ===
    if (url.pathname === '/api/admin/create-invite') {
        if (!await checkAuth(cookie, env, true)) return new Response('Unauthorized', { status: 401 });
        
        const params = await request.json();
        const id = env.CHAT_ROOM.idFromName('chat-room');
        const stub = env.CHAT_ROOM.get(id);
        return stub.fetch(new Request(`${url.origin}/internal/create-invite`, {
            method: 'POST',
            body: JSON.stringify(params)
        }));
    }
    
    // === API: 检查权限 ===
    if (url.pathname === '/api/check-auth') {
        const isAdmin = await checkAuth(cookie, env, true);
        return new Response(JSON.stringify({ isAdmin }));
    }

    // === 核心拦截逻辑 ===
    
    // WebSocket
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader && upgradeHeader === 'websocket') {
      if (!await checkAuth(cookie, env)) {
         return new Response('Unauthorized', { status: 401 });
      }
      const id = env.CHAT_ROOM.idFromName('chat-room');
      const stub = env.CHAT_ROOM.get(id);
      return stub.fetch(request);
    }

    // 特殊页面路由
    if (url.pathname === '/admin' || url.pathname === '/join') {
         const newHeaders = new Headers(request.headers);
         newHeaders.set('X-Internal-Bypass', 'true');
         const newReq = new Request(`${url.origin}/index.html`, {
             method: request.method,
             headers: newHeaders,
             body: request.body
         });
         return env.ASSETS.fetch(newReq);
    }

    // 静态资源与鉴权
    const isAuthorized = await checkAuth(cookie, env);
    const isInternalBypass = request.headers.get('X-Internal-Bypass') === 'true';

    // 伪装逻辑
    if ((url.pathname === '/' || url.pathname.endsWith('.html')) && !isInternalBypass) {
        if (!isAuthorized) {
            if (env.URL) {
                try {
                    const proxyUrl = new URL(env.URL);
                    const proxyReq = new Request(proxyUrl.toString(), {
                        method: request.method,
                        headers: request.headers,
                        redirect: 'follow'
                    });
                    const proxyRes = await fetch(proxyReq);
                    return new Response(proxyRes.body, proxyRes);
                } catch (e) {
                    return new Response(NGINX_TEMPLATE, { headers: { "Content-Type": "text/html" } });
                }
            } else {
                return new Response(NGINX_TEMPLATE, { headers: { "Content-Type": "text/html" } });
            }
        }
    }

    return env.ASSETS.fetch(request);
  }
};

// === 辅助函数 ===
async function generateToken(secret, prefix) {
    const msgUint8 = new TextEncoder().encode(secret + "salt_v1");
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return `${prefix}_${hashArray.map(b => b.toString(16).padStart(2, '0')).join('')}`;
}

async function checkAuth(cookieStr, env, requireAdmin = false) {
    if (!cookieStr) return false;
    const match = cookieStr.match(/auth=([^;]+)/);
    if (!match) return false;
    const token = match[1];

    if (token.startsWith('admin_')) {
        const expected = await generateToken(env.PWD, 'admin');
        return token === expected;
    }
    
    if (requireAdmin) return false; 
    return token.startsWith('guest_') && token.length > 10; 
}


// === Durable Object ===
export class ChatRoom {
  constructor(state, env) {
    this.state = state;
    this.clients = {};
    this.channels = {};
    this.config = { seenTimeout: 60000, debug: false };
    this.initRSAKeyPair();
  }

  async fetch(request) {
    const url = new URL(request.url);

    // [DO] 创建邀请码
    if (url.pathname.endsWith('/internal/create-invite')) {
        const { maxUses, note, expireMinutes, room, needPwd } = await request.json();
        const code = crypto.randomUUID().split('-')[0];
        const invite = {
            code,
            maxUses: maxUses || 0,
            uses: 0,
            createdAt: Date.now(),
            expireAt: expireMinutes ? Date.now() + (expireMinutes * 60 * 1000) : null,
            note,
            room: room || '', // 绑定的房间名
            needPwd: !!needPwd // 是否需要密码
        };
        await this.state.storage.put('invite:' + code, invite);
        return new Response(JSON.stringify(invite));
    }

    // [DO] 验证邀请码
    if (url.pathname.endsWith('/internal/verify-invite')) {
        const { code } = await request.json();
        const invite = await this.state.storage.get('invite:' + code);
        
        if (!invite) return new Response('Not Found', { status: 404 });
        
        // 检查次数
        if (invite.maxUses > 0 && invite.uses >= invite.maxUses) return new Response('Expired', { status: 403 });
        
        // 检查过期时间
        if (invite.expireAt && Date.now() > invite.expireAt) return new Response('Expired', { status: 403 });

        invite.uses += 1;
        await this.state.storage.put('invite:' + code, invite);
        
        const token = 'guest_' + crypto.randomUUID();
        // 返回房间信息供前端跳转
        return new Response(JSON.stringify({ 
            token, 
            room: invite.room,
            needPwd: invite.needPwd
        }));
    }

    // WebSocket 保持原样
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader !== 'websocket') return new Response('Expected WebSocket Upgrade', { status: 426 });

    if (!this.keyPair) await this.initRSAKeyPair();
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);
    this.handleSession(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  // === 原有 WebSocket 逻辑 (省略以节省空间，功能不变) ===
  async initRSAKeyPair() {
      try {
      let stored = await this.state.storage.get('rsaKeyPair');
      if (!stored) {
          const keyPair = await crypto.subtle.generateKey(
          { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
          true, ['sign', 'verify']
        );
        const [publicKeyBuffer, privateKeyBuffer] = await Promise.all([
          crypto.subtle.exportKey('spki', keyPair.publicKey),
          crypto.subtle.exportKey('pkcs8', keyPair.privateKey)
        ]);
        stored = {
          rsaPublic: btoa(String.fromCharCode(...new Uint8Array(publicKeyBuffer))),
          rsaPrivateData: Array.from(new Uint8Array(privateKeyBuffer)),
          createdAt: Date.now() 
        };
        await this.state.storage.put('rsaKeyPair', stored);
      }
      if (stored.rsaPrivateData) {
        const privateKeyBuffer = new Uint8Array(stored.rsaPrivateData);
        stored.rsaPrivate = await crypto.subtle.importKey(
          'pkcs8', privateKeyBuffer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']
        );      }
        this.keyPair = stored;
      } catch (e) { console.error(e); }
  }

  async handleSession(connection) {    
      connection.accept();
      await this.cleanupOldConnections();
      const clientId = generateClientId();
      if (!clientId || this.clients[clientId]) { this.closeConnection(connection); return; }
      
      this.clients[clientId] = { connection, seen: getTime(), key: null, shared: null, channel: null };
      try { this.sendMessage(connection, JSON.stringify({ type: 'server-key', key: this.keyPair.rsaPublic })); } catch (e) {}

      connection.addEventListener('message', async (event) => {
          const message = event.data;
          if (!isString(message) || !this.clients[clientId]) return;
          this.clients[clientId].seen = getTime();
          if (message === 'ping') { this.sendMessage(connection, 'pong'); return; }

          if (!this.clients[clientId].shared && message.length < 2048) {
              try {
                const keys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-384' }, true, ['deriveBits', 'deriveKey']);
                const publicKeyBuffer = await crypto.subtle.exportKey('raw', keys.publicKey);
                const signature = await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, this.keyPair.rsaPrivate, publicKeyBuffer);
                const clientPublicKeyBytes = new Uint8Array(message.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
                const clientPublicKey = await crypto.subtle.importKey('raw', clientPublicKeyBytes, { name: 'ECDH', namedCurve: 'P-384' }, false, []);
                const sharedSecretBits = await crypto.subtle.deriveBits({ name: 'ECDH', public: clientPublicKey }, keys.privateKey, 384);          
                this.clients[clientId].shared = new Uint8Array(sharedSecretBits).slice(8, 40);
                const response = Array.from(new Uint8Array(publicKeyBuffer)).map(b => b.toString(16).padStart(2, '0')).join('') + '|' + btoa(String.fromCharCode(...new Uint8Array(signature)));
                this.sendMessage(connection, response);
            } catch (error) { this.closeConnection(connection); }
            return;
          }
          if (this.clients[clientId].shared) this.processEncryptedMessage(clientId, message);
      });

      connection.addEventListener('close', async () => {
          const channel = this.clients[clientId].channel;
          if (channel && this.channels[channel]) {
            this.channels[channel].splice(this.channels[channel].indexOf(clientId), 1);
            if (this.channels[channel].length === 0) delete(this.channels[channel]);
            else this.broadcastMemberList(channel); 
          }
          delete(this.clients[clientId]);
      });
  }

  processEncryptedMessage(clientId, message) {
    try {
      const decrypted = decryptMessage(message, this.clients[clientId].shared);
      if (!isObject(decrypted) || !isString(decrypted.a)) return;
      if (decrypted.a === 'j') this.handleJoinChannel(clientId, decrypted);
      else if (decrypted.a === 'c') this.handleClientMessage(clientId, decrypted);
      else if (decrypted.a === 'w') this.handleChannelMessage(clientId, decrypted);
    } catch (e) {}
  }
  handleJoinChannel(clientId, decrypted) {
      const channel = decrypted.p;
      this.clients[clientId].channel = channel;
      if (!this.channels[channel]) this.channels[channel] = [clientId];
      else this.channels[channel].push(clientId);
      this.broadcastMemberList(channel);
  }
  handleClientMessage(clientId, decrypted) {
       try {
        const channel = this.clients[clientId].channel;
        const targetClient = this.clients[decrypted.c];
        if (this.isClientInChannel(targetClient, channel)) {
            const messageObj = { a: 'c', p: decrypted.p, c: clientId };
            const encrypted = encryptMessage(messageObj, targetClient.shared);
            this.sendMessage(targetClient.connection, encrypted);
        }
      } catch (e) {}
  }
  handleChannelMessage(clientId, decrypted) {
      try {
      const channel = this.clients[clientId].channel;
      const validMembers = Object.keys(decrypted.p).filter(member => {
        const targetClient = this.clients[member];
        return isString(decrypted.p[member]) && this.isClientInChannel(targetClient, channel);
      });
      for (const member of validMembers) {
        const targetClient = this.clients[member];
        this.sendMessage(targetClient.connection, encryptMessage({ a: 'c', p: decrypted.p[member], c: clientId }, targetClient.shared));
      }
    } catch (e) {}
  }
  broadcastMemberList(channel) {
      try {
      const members = this.channels[channel];
      for (const member of members) {
        const client = this.clients[member];
        if (this.isClientInChannel(client, channel)) {
          this.sendMessage(client.connection, encryptMessage({ a: 'l', p: members.filter(v => v !== member) }, client.shared));
        }
      }
    } catch (e) {}
  }
  isClientInChannel(client, channel) { return client && client.connection && client.shared && client.channel === channel; }
  sendMessage(conn, msg) { if (conn.readyState === 1) conn.send(msg); }
  closeConnection(conn) { try { conn.close(); } catch(e){} }
  async cleanupOldConnections() { 
      const seenThreshold = getTime() - this.config.seenTimeout;
      const clientsToRemove = [];
      for (const cid in this.clients) if (this.clients[cid].seen < seenThreshold) clientsToRemove.push(cid);
      for (const cid of clientsToRemove) { this.clients[cid].connection.close(); delete this.clients[cid]; }
      return clientsToRemove.length;
  }
}
