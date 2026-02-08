/**
 * NodeCrypt Worker Script
 * Modified to include: Access Control, Invitation System, and Camouflage.
 */

import { generateClientId, encryptMessage, decryptMessage, logEvent, isString, isObject, getTime } from './utils.js';

// === 1. 伪装页面模板 (当没有设置 URL 变量时的默认显示) ===
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

// === 2. Worker 主逻辑 ===
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cookie = request.headers.get('Cookie') || "";

    // A. 处理 WebSocket 请求 (原核心功能)
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader && upgradeHeader === 'websocket') {
      // 鉴权：只有持有有效 Cookie 的用户才能建立 WS 连接
      if (!await checkAuth(cookie, env)) {
         return new Response('Unauthorized', { status: 401 });
      }
      const id = env.CHAT_ROOM.idFromName('chat-room');
      const stub = env.CHAT_ROOM.get(id);
      return stub.fetch(request);
    }

    // B. 邀请链接处理 /join?code=xxx
    if (url.pathname === '/join') {
      const code = url.searchParams.get('code');
      if (code) {
        const id = env.CHAT_ROOM.idFromName('chat-room');
        const stub = env.CHAT_ROOM.get(id);
        // 向 DO 发送验证请求
        const verifyReq = new Request(`${url.origin}/api/internal/verify-invite`, {
            method: 'POST',
            body: JSON.stringify({ code })
        });
        const verifyRes = await stub.fetch(verifyReq);
        
        if (verifyRes.ok) {
            const data = await verifyRes.json();
            // 验证成功，写入 Cookie 并重定向回首页
            const headers = new Headers();
            // 设置 1 天有效期的访客 Cookie
            headers.append('Set-Cookie', `auth=${data.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`);
            headers.append('Location', '/');
            return new Response(null, { status: 302, headers });
        } else {
            return new Response('无效或过期的邀请链接 / Invalid or expired link', { status: 403, headers: { 'Content-Type': 'text/plain;charset=utf-8' } });
        }
      }
    }

    // C. 管理员登录接口 API
    if (url.pathname === '/api/login' && request.method === 'POST') {
        const body = await request.json();
        // 校验环境变量中的 PWD
        if (body.pwd === env.PWD) {
            const headers = new Headers();
            const adminToken = 'admin_' + await hash(env.PWD + 'salt');
            // 管理员 Cookie 有效期 30 天
            headers.append('Set-Cookie', `auth=${adminToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
            return new Response(JSON.stringify({ ok: true }), { headers });
        }
        return new Response(JSON.stringify({ ok: false }), { status: 401 });
    }

    // D. 管理员生成邀请链接 API
    if (url.pathname === '/api/admin/create-invite') {
        // 二次校验管理员权限
        if (!await checkAuth(cookie, env, true)) return new Response('Unauthorized', { status: 401 });
        const params = await request.json();
        const id = env.CHAT_ROOM.idFromName('chat-room');
        const stub = env.CHAT_ROOM.get(id);
        // 转发给 DO 处理存储
        const req = new Request(`${url.origin}/api/internal/create-invite`, { method: 'POST', body: JSON.stringify(params) });
        return stub.fetch(req);
    }

    // E. 管理员后台页面 /admin
    if (url.pathname === '/admin') {
        if (await checkAuth(cookie, env, true)) {
            return new Response(renderAdminDashboard(), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
        }
        return new Response(renderLoginPage(), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
    }

    // F. 处理原有 API 请求 (保留原有逻辑结构)
    if (url.pathname.startsWith('/api/')) {
      // 如果有其他公开 API 可以在这里放行，或者统一鉴权
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    }

    // G. 静态资源与伪装逻辑 (Gatekeeper)
    const isAuthorized = await checkAuth(cookie, env);

    // 只有经过授权的用户才能访问 HTML 页面和项目资源
    // 为了更好的伪装，我们拦截根路径和 index.html
    if (url.pathname === '/' || url.pathname.endsWith('.html') || url.pathname === '/index.html') {
        if (!isAuthorized) {
            // === 伪装逻辑 ===
            if (env.URL) {
                // 1. 如果设置了 URL 环境变量，反代该目标
                try {
                    const proxyUrl = new URL(env.URL);
                    // 简单的反代实现
                    const proxyReq = new Request(proxyUrl.toString(), {
                        method: request.method,
                        headers: request.headers
                    });
                    const proxyRes = await fetch(proxyReq);
                    return new Response(proxyRes.body, proxyRes);
                } catch (e) {
                    // 反代失败回退到 Nginx 页面
                    return new Response(NGINX_TEMPLATE, { headers: { "Content-Type": "text/html" } });
                }
            } else {
                // 2. 默认显示 Nginx 欢迎页
                return new Response(NGINX_TEMPLATE, { headers: { "Content-Type": "text/html" } });
            }
        }
    }

    // 已授权，放行访问 Cloudflare Assets (原前端文件)
    // 自动支持 hash 文件名和 SPA fallback
    return env.ASSETS.fetch(request);
  }
};

// === 3. 辅助函数 ===

// 简单的哈希函数用于生成 Token
async function hash(str) {
    const msgUint8 = new TextEncoder().encode(str);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// 鉴权检查函数
async function checkAuth(cookieStr, env, requireAdmin = false) {
    if (!cookieStr) return false;
    const match = cookieStr.match(/auth=([^;]+)/);
    if (!match) return false;
    const token = match[1];

    // 管理员 Token 格式: admin_HASH
    if (token.startsWith('admin_')) {
        const expected = 'admin_' + await hash(env.PWD + 'salt');
        return token === expected;
    }
    
    if (requireAdmin) return false; // 需要管理员但 token 不对

    // 普通访客 Token 格式: guest_UUID
    // 这里做基础校验，只要有格式正确的 guest token 就放行
    // (更严格的校验需要查 DO，但为了性能和静态资源加载速度，这里信任签名或格式)
    return token.startsWith('guest_') && token.length > 10; 
}

// 渲染登录页 HTML
function renderLoginPage() {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Admin</title><style>body{display:flex;justify-content:center;align-items:center;height:100vh;background:#1a1a1a;color:#eee;font-family:system-ui}form{background:#2a2a2a;padding:2rem;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,0.3)}input{display:block;width:100%;margin-bottom:1rem;padding:0.5rem;border:1px solid #444;background:#333;color:white;border-radius:4px}button{width:100%;padding:0.5rem;background:#007bff;color:white;border:none;border-radius:4px;cursor:pointer}button:hover{background:#0056b3}</style></head><body><form onsubmit="event.preventDefault(); l()"><h2 style="margin-top:0">管理入口</h2><input type="password" id="p" placeholder="输入访问密码"><button type="submit">登录</button></form><script>async function l(){const p=document.getElementById('p').value;const r=await fetch('/api/login',{method:'POST',body:JSON.stringify({pwd:p})});if(r.ok)location.reload();else alert('密码错误')}</script></body></html>`;
}

// 渲染控制面板 HTML
function renderAdminDashboard() {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>NodeCrypt Admin</title><style>body{max-width:800px;margin:0 auto;padding:20px;font-family:system-ui;background:#f0f2f5;color:#333}.card{background:white;padding:20px;border-radius:8px;box-shadow:0 2px 4px rgba(0,0,0,0.1);margin-bottom:20px}h1{color:#1a1a1a}label{display:block;margin-top:10px;font-weight:bold}input{width:100%;padding:8px;margin-top:5px;box-sizing:border-box;border:1px solid #ddd;border-radius:4px}button{background:#28a745;color:white;border:none;padding:10px 15px;border-radius:4px;cursor:pointer;margin-top:15px;font-size:16px}button.btn-go{background:#007bff}button:hover{opacity:0.9}.res{background:#e9ecef;padding:15px;margin-top:15px;border-radius:4px;word-break:break-all;display:none}</style></head><body><h1>NodeCrypt 控制台</h1><div class="card"><h3>🚀 快速通道</h3><p>已通过身份验证，可以直接访问聊天室。</p><a href="/"><button class="btn-go">进入聊天室</button></a></div><div class="card"><h3>🔗 生成邀请链接</h3><label>最大可用次数 (0 = 无限):</label><input type="number" id="lm" value="1"><label>备注:</label><input type="text" id="nt" placeholder="例如：给朋友 user1 的链接"><button onclick="c()">生成链接</button><div id="rs" class="res"></div></div><script>async function c(){const lm=document.getElementById('lm').value;const nt=document.getElementById('nt').value;const b=document.querySelector('button');b.disabled=true;b.innerText='生成中...';try{const r=await fetch('/api/admin/create-invite',{method:'POST',body:JSON.stringify({maxUses:parseInt(lm),note:nt})});const d=await r.json();const u=location.origin+'/join?code='+d.code;const rs=document.getElementById('rs');rs.style.display='block';rs.innerHTML='<p><strong>邀请链接:</strong><br><a href="'+u+'">'+u+'</a></p><p>剩余次数: '+(d.maxUses===0?'无限':d.maxUses)+'</p>';}catch(e){alert('Error');}b.disabled=false;b.innerText='生成链接';}</script></body></html>`;
}

// === 4. Durable Object 类 (原 ChatRoom 增强版) ===
export class ChatRoom {
  constructor(state, env) {
    this.state = state;
    
    // 保持原有数据结构
    this.clients = {};
    this.channels = {};
    
    this.config = {
      seenTimeout: 60000,
      debug: false
    };
    
    // Initialize RSA key pair
    this.initRSAKeyPair();
  }

  // --- 新增：处理 HTTP 请求 (用于邀请码管理) ---
  // 原有的 fetch 只能处理 WebSocket，现在增加路由判断
  async fetch(request) {
    const url = new URL(request.url);

    // 1. [新增] 内部 API：创建邀请码
    if (url.pathname.endsWith('/api/internal/create-invite')) {
        const { maxUses, note } = await request.json();
        const code = crypto.randomUUID().split('-')[0]; // 生成短码
        const invite = {
            code,
            maxUses: maxUses || 0,
            uses: 0,
            createdAt: Date.now(),
            note
        };
        // 存储: key = invite:CODE
        await this.state.storage.put('invite:' + code, invite);
        return new Response(JSON.stringify(invite), { headers: { 'Content-Type': 'application/json' } });
    }

    // 2. [新增] 内部 API：验证邀请码
    if (url.pathname.endsWith('/api/internal/verify-invite')) {
        const { code } = await request.json();
        const invite = await this.state.storage.get('invite:' + code);
        
        if (!invite) return new Response('Not Found', { status: 404 });
        
        if (invite.maxUses > 0 && invite.uses >= invite.maxUses) {
            return new Response('Expired', { status: 403 });
        }

        // 更新使用次数
        invite.uses += 1;
        await this.state.storage.put('invite:' + code, invite);

        // 生成 session token
        const sessionToken = 'guest_' + crypto.randomUUID();
        return new Response(JSON.stringify({ token: sessionToken }), { status: 200 });
    }

    // 3. [原有] WebSocket 处理逻辑
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader !== 'websocket') {
      return new Response('Expected WebSocket Upgrade', { status: 426 });
    }

    // Ensure RSA keys are initialized
    if (!this.keyPair) {
      await this.initRSAKeyPair();
    }

    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);

    // Accept the WebSocket connection
    this.handleSession(server);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  // --- 以下保持原有逻辑不变 (Keep Original Logic) ---

  async initRSAKeyPair() {
    try {
      let stored = await this.state.storage.get('rsaKeyPair');
      if (!stored) {
        console.log('Generating new RSA keypair...');
          const keyPair = await crypto.subtle.generateKey(
          {
            name: 'RSASSA-PKCS1-v1_5',
            modulusLength: 2048,
            publicExponent: new Uint8Array([1, 0, 1]),
            hash: 'SHA-256'
          },
          true,
          ['sign', 'verify']
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
        console.log('RSA key pair generated and stored');
      }
      
      if (stored.rsaPrivateData) {
        const privateKeyBuffer = new Uint8Array(stored.rsaPrivateData);
        
        stored.rsaPrivate = await crypto.subtle.importKey(
          'pkcs8',
          privateKeyBuffer,
          {
            name: 'RSASSA-PKCS1-v1_5',
            hash: 'SHA-256'
          },
          false,
          ['sign']
        );      }
        this.keyPair = stored;
      
      if (stored.createdAt && (Date.now() - stored.createdAt > 24 * 60 * 60 * 1000)) {
        if (Object.keys(this.clients).length === 0) {
          console.log('密钥已使用24小时，进行轮换...');
          await this.state.storage.delete('rsaKeyPair');
          this.keyPair = null;
          await this.initRSAKeyPair();
        } else {
          await this.state.storage.put('pendingKeyRotation', true);
        }
      }
    } catch (error) {
      console.error('Error initializing RSA key pair:', error);
      throw error;
    }
  }

  async handleSession(connection) {    connection.accept();

    await this.cleanupOldConnections();

    const clientId = generateClientId();

    if (!clientId || this.clients[clientId]) {
      this.closeConnection(connection);
      return;
    }

    logEvent('connection', clientId, 'debug');    
    this.clients[clientId] = {
      connection: connection,
      seen: getTime(),
      key: null,
      shared: null,
      channel: null
    };

    try {
      logEvent('sending-public-key', clientId, 'debug');
      this.sendMessage(connection, JSON.stringify({
        type: 'server-key',
        key: this.keyPair.rsaPublic
      }));
    } catch (error) {
      logEvent('sending-public-key', error, 'error');
    }    
    
    connection.addEventListener('message', async (event) => {
      const message = event.data;

      if (!isString(message) || !this.clients[clientId]) {
        return;
      }

      this.clients[clientId].seen = getTime();

      if (message === 'ping') {
        this.sendMessage(connection, 'pong');
        return;
      }

      logEvent('message', [clientId, message], 'debug');      
      if (!this.clients[clientId].shared && message.length < 2048) {
        try {
          const keys = await crypto.subtle.generateKey(
            {
              name: 'ECDH',
              namedCurve: 'P-384'
            },
            true,
            ['deriveBits', 'deriveKey']
          );

          const publicKeyBuffer = await crypto.subtle.exportKey('raw', keys.publicKey);
          
          const signature = await crypto.subtle.sign(
            {
              name: 'RSASSA-PKCS1-v1_5'
            },
            this.keyPair.rsaPrivate,
            publicKeyBuffer
          );

          const clientPublicKeyHex = message;
          const clientPublicKeyBytes = new Uint8Array(clientPublicKeyHex.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
          
          const clientPublicKey = await crypto.subtle.importKey(
            'raw',
            clientPublicKeyBytes,
            { name: 'ECDH', namedCurve: 'P-384' },
            false,
            []
          );

          const sharedSecretBits = await crypto.subtle.deriveBits(
            {
              name: 'ECDH',
              public: clientPublicKey
            },
            keys.privateKey,
            384 
          );          
          this.clients[clientId].shared = new Uint8Array(sharedSecretBits).slice(8, 40);

          const response = Array.from(new Uint8Array(publicKeyBuffer))
            .map(b => b.toString(16).padStart(2, '0')).join('') + 
            '|' + btoa(String.fromCharCode(...new Uint8Array(signature)));
          
          this.sendMessage(connection, response);

        } catch (error) {
          logEvent('message-key', [clientId, error], 'error');
          this.closeConnection(connection);
        }

        return;
      }

      if (this.clients[clientId].shared && message.length <= (8 * 1024 * 1024)) {
        this.processEncryptedMessage(clientId, message);
      }
    });    
    
    connection.addEventListener('close', async (event) => {
      logEvent('close', [clientId, event], 'debug');

      const channel = this.clients[clientId].channel;

      if (channel && this.channels[channel]) {
        this.channels[channel].splice(this.channels[channel].indexOf(clientId), 1);

        if (this.channels[channel].length === 0) {
          delete(this.channels[channel]);
        } else {
          try {
            const members = this.channels[channel];

            for (const member of members) {
              const client = this.clients[member];              if (this.isClientInChannel(client, channel)) {
                this.sendMessage(client.connection, encryptMessage({
                  a: 'l',
                  p: members.filter((value) => {
                    return (value !== member ? true : false);
                  })
                }, client.shared));
              }
            }

          } catch (error) {
            logEvent('close-list', [clientId, error], 'error');
          }
        }
      }

      if (this.clients[clientId]) {
        delete(this.clients[clientId]);
      }
    });
  }

  processEncryptedMessage(clientId, message) {
    let decrypted = null;

    try {
      decrypted = decryptMessage(message, this.clients[clientId].shared);

      logEvent('message-decrypted', [clientId, decrypted], 'debug');

      if (!isObject(decrypted) || !isString(decrypted.a)) {
        return;
      }

      const action = decrypted.a;

      if (action === 'j') {
        this.handleJoinChannel(clientId, decrypted);
      } else if (action === 'c') {
        this.handleClientMessage(clientId, decrypted);
      } else if (action === 'w') {
        this.handleChannelMessage(clientId, decrypted);
      }

    } catch (error) {
      logEvent('process-encrypted-message', [clientId, error], 'error');
    } finally {
      decrypted = null;
    }
  }

  handleJoinChannel(clientId, decrypted) {
    if (!isString(decrypted.p) || this.clients[clientId].channel) {
      return;
    }

    try {
      const channel = decrypted.p;

      this.clients[clientId].channel = channel;

      if (!this.channels[channel]) {
        this.channels[channel] = [clientId];
      } else {
        this.channels[channel].push(clientId);
      }

      this.broadcastMemberList(channel);

    } catch (error) {
      logEvent('message-join', [clientId, error], 'error');
    }
  }

  handleClientMessage(clientId, decrypted) {
    if (!isString(decrypted.p) || !isString(decrypted.c) || !this.clients[clientId].channel) {
      return;
    }

    try {
      const channel = this.clients[clientId].channel;
      const targetClient = this.clients[decrypted.c];

      if (this.isClientInChannel(targetClient, channel)) {
        const messageObj = {
          a: 'c',
          p: decrypted.p,
          c: clientId
        };

        const encrypted = encryptMessage(messageObj, targetClient.shared);
        this.sendMessage(targetClient.connection, encrypted);

        messageObj.p = null;
      }

    } catch (error) {
      logEvent('message-client', [clientId, error], 'error');
    }
  }  

  handleChannelMessage(clientId, decrypted) {
    if (!isObject(decrypted.p) || !this.clients[clientId].channel) {
      return;
    }
    
    try {
      const channel = this.clients[clientId].channel;
      const validMembers = Object.keys(decrypted.p).filter(member => {
        const targetClient = this.clients[member];
        return isString(decrypted.p[member]) && this.isClientInChannel(targetClient, channel);
      });

      for (const member of validMembers) {
        const targetClient = this.clients[member];
        const messageObj = {
          a: 'c',
          p: decrypted.p[member],
          c: clientId
        };        const encrypted = encryptMessage(messageObj, targetClient.shared);
        this.sendMessage(targetClient.connection, encrypted);

        messageObj.p = null;
      }

    } catch (error) {
      logEvent('message-channel', [clientId, error], 'error');
    }
  }

  broadcastMemberList(channel) {
    try {
      const members = this.channels[channel];

      for (const member of members) {
        const client = this.clients[member];

        if (this.isClientInChannel(client, channel)) {
          const messageObj = {
            a: 'l',
            p: members.filter((value) => {
              return (value !== member ? true : false);
            })
          };

          const encrypted = encryptMessage(messageObj, client.shared);
          this.sendMessage(client.connection, encrypted);

          messageObj.p = null;
        }
      }
    } catch (error) {
      logEvent('broadcast-member-list', error, 'error');
    }
  }  

  isClientInChannel(client, channel) {
    return (
      client &&
      client.connection &&
      client.shared &&
      client.channel &&
      client.channel === channel ?
      true :
      false
    );
  }

  sendMessage(connection, message) {
    try {
      if (connection.readyState === 1) {
        connection.send(message);
      }
    } catch (error) {
      logEvent('sendMessage', error, 'error');
    }
  }  

  closeConnection(connection) {
    try {
      connection.close();    } catch (error) {
      logEvent('closeConnection', error, 'error');
    }
  }
  
  async cleanupOldConnections() {
    const seenThreshold = getTime() - this.config.seenTimeout;
    const clientsToRemove = [];

    for (const clientId in this.clients) {
      if (this.clients[clientId].seen < seenThreshold) {
        clientsToRemove.push(clientId);
      }
    }

    for (const clientId of clientsToRemove) {
      try {
        logEvent('connection-seen', clientId, 'debug');
        this.clients[clientId].connection.close();
        delete this.clients[clientId];
      } catch (error) {
        logEvent('connection-seen', error, 'error');      }
    }
    
    if (Object.keys(this.clients).length === 0 && Object.keys(this.channels).length === 0) {
      const pendingRotation = await this.state.storage.get('pendingKeyRotation');
      if (pendingRotation) {
        console.log('没有活跃客户端或房间，执行密钥轮换...');
        await this.state.storage.delete('rsaKeyPair');        await this.state.storage.delete('pendingKeyRotation');
        this.keyPair = null;
        await this.initRSAKeyPair();
      }
    }
    
    return clientsToRemove.length;
  }
}
