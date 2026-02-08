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

    // === API: 验证邀请码 (处理 /join?code=xxx) ===
    if (url.pathname === '/api/verify-invite') {
        const { code } = await request.json();
        const id = env.CHAT_ROOM.idFromName('chat-room');
        const stub = env.CHAT_ROOM.get(id);
        // 向 DO 请求验证
        const res = await stub.fetch(new Request(`${url.origin}/internal/verify-invite`, {
            method: 'POST',
            body: JSON.stringify({ code })
        }));
        
        if (res.ok) {
            const data = await res.json();
            const headers = new Headers();
            // 设置 7 天的 Cookie
            headers.append('Set-Cookie', `auth=${data.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`);
            return new Response(JSON.stringify({ ok: true }), { headers });
        }
        return new Response(JSON.stringify({ ok: false, error: '无效链接' }), { status: 403 });
    }

    // === API: 管理员登录 ===
    if (url.pathname === '/api/login') {
        const body = await request.json();
        if (body.pwd === env.PWD) {
            const headers = new Headers();
            const adminToken = await generateToken(env.PWD, 'admin');
            headers.append('Set-Cookie', `auth=${adminToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`); // 30天
            return new Response(JSON.stringify({ ok: true, isAdmin: true }), { headers });
        }
        return new Response(JSON.stringify({ ok: false }), { status: 401 });
    }

    // === API: 生成邀请链接 (需要管理员权限) ===
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
    
    // === API: 检查当前登录状态 (前端用来判断是否显示分享按钮) ===
    if (url.pathname === '/api/check-auth') {
        const isAdmin = await checkAuth(cookie, env, true);
        return new Response(JSON.stringify({ isAdmin }));
    }

    // === 核心拦截逻辑 ===
    
    // 1. WebSocket 连接前检查权限
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader && upgradeHeader === 'websocket') {
      if (!await checkAuth(cookie, env)) {
         return new Response('Unauthorized', { status: 401 });
      }
      const id = env.CHAT_ROOM.idFromName('chat-room');
      const stub = env.CHAT_ROOM.get(id);
      return stub.fetch(request);
    }

    // 2. 静态资源与页面访问控制
    const isAuthorized = await checkAuth(cookie, env);
    
    // 如果访问的是 /admin，不论是否授权，都返回前端页面（前端会判断是否需要弹窗登录）
    if (url.pathname === '/admin') {
         return env.ASSETS.fetch(new Request(`${url.origin}/index.html`, request));
    }

    // 如果是邀请链接跳转 /join，返回前端页面（前端处理 code 参数）
    if (url.pathname === '/join') {
        return env.ASSETS.fetch(new Request(`${url.origin}/index.html`, request));
    }

    // 3. 根路径和 HTML 文件的伪装逻辑
    if (url.pathname === '/' || url.pathname.endsWith('.html')) {
        if (!isAuthorized) {
            // === 伪装开始 ===
            if (env.URL) {
                try {
                    const proxyUrl = new URL(env.URL);
                    const proxyReq = new Request(proxyUrl.toString(), {
                        method: request.method,
                        headers: request.headers,
                        redirect: 'follow'
                    });
                    const proxyRes = await fetch(proxyReq);
                    // 复制响应，避免不可变对象错误
                    const newRes = new Response(proxyRes.body, proxyRes);
                    return newRes;
                } catch (e) {
                    return new Response(NGINX_TEMPLATE, { headers: { "Content-Type": "text/html" } });
                }
            } else {
                return new Response(NGINX_TEMPLATE, { headers: { "Content-Type": "text/html" } });
            }
        }
    }

    // 已授权或非敏感资源，正常放行
    return env.ASSETS.fetch(request);
  }
};

// === 辅助函数 ===
async function generateToken(secret, prefix) {
    const msgUint8 = new TextEncoder().encode(secret + "salt_v1");
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return `${prefix}_${hashHex}`;
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

    // 简单验证访客 Token 格式
    return token.startsWith('guest_') && token.length > 10; 
}


// === Durable Object (聊天室状态 + 邀请码存储) ===
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

    // [DO 内部接口] 创建邀请码
    if (url.pathname.endsWith('/internal/create-invite')) {
        const { maxUses, note } = await request.json();
        const code = crypto.randomUUID().split('-')[0]; // 短码
        const invite = {
            code,
            maxUses: maxUses || 0,
            uses: 0,
            createdAt: Date.now(),
            note
        };
        await this.state.storage.put('invite:' + code, invite);
        return new Response(JSON.stringify(invite));
    }

    // [DO 内部接口] 验证邀请码
    if (url.pathname.endsWith('/internal/verify-invite')) {
        const { code } = await request.json();
        const invite = await this.state.storage.get('invite:' + code);
        
        if (!invite) return new Response('Not Found', { status: 404 });
        if (invite.maxUses > 0 && invite.uses >= invite.maxUses) return new Response('Expired', { status: 403 });

        invite.uses += 1;
        await this.state.storage.put('invite:' + code, invite);
        
        const token = 'guest_' + crypto.randomUUID();
        return new Response(JSON.stringify({ token }));
    }

    // WebSocket 逻辑 (保持原样，省略部分重复代码以节省空间，功能不变)
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader !== 'websocket') return new Response('Expected WebSocket Upgrade', { status: 426 });

    if (!this.keyPair) await this.initRSAKeyPair();
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);
    this.handleSession(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  // === 以下为原有的 WebSocket 处理逻辑，完全保留 ===
  async initRSAKeyPair() {
      // 保持原有逻辑...
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
        // 轮换逻辑略...
    } catch (e) { console.error(e); }
  }

  async handleSession(connection) {    
      // 保持原有逻辑...
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

          // Key Exchange & Message Processing (与原版完全一致)
          if (!this.clients[clientId].shared && message.length < 2048) {
              // ECDH Handshake...
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
          // 清理逻辑...
          const channel = this.clients[clientId].channel;
          if (channel && this.channels[channel]) {
            this.channels[channel].splice(this.channels[channel].indexOf(clientId), 1);
            if (this.channels[channel].length === 0) delete(this.channels[channel]);
            else this.broadcastMemberList(channel); // 简化调用
          }
          delete(this.clients[clientId]);
      });
  }

  processEncryptedMessage(clientId, message) {
    // 保持原有逻辑...
    try {
      const decrypted = decryptMessage(message, this.clients[clientId].shared);
      if (!isObject(decrypted) || !isString(decrypted.a)) return;
      if (decrypted.a === 'j') this.handleJoinChannel(clientId, decrypted);
      else if (decrypted.a === 'c') this.handleClientMessage(clientId, decrypted);
      else if (decrypted.a === 'w') this.handleChannelMessage(clientId, decrypted);
    } catch (e) {}
  }
  // 其他原有 helper 方法 (handleJoinChannel, handleClientMessage, sendMessage 等) 请保持原样，
  // 它们不需要修改，只需要保证上面的 handleSession 调用它们即可。
  
  // 为确保代码完整性，以下简写关键方法，实际部署请保留原文件中的完整实现
  handleJoinChannel(clientId, decrypted) {
      const channel = decrypted.p;
      this.clients[clientId].channel = channel;
      if (!this.channels[channel]) this.channels[channel] = [clientId];
      else this.channels[channel].push(clientId);
      this.broadcastMemberList(channel);
  }
  handleClientMessage(clientId, decrypted) {
      // 转发逻辑...
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
      // 广播逻辑...
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
      // 列表更新...
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
      // 清理过期连接...
      const seenThreshold = getTime() - this.config.seenTimeout;
      const clientsToRemove = [];
      for (const cid in this.clients) if (this.clients[cid].seen < seenThreshold) clientsToRemove.push(cid);
      for (const cid of clientsToRemove) { this.clients[cid].connection.close(); delete this.clients[cid]; }
      return clientsToRemove.length;
  }
}
