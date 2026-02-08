// 导入依赖
import './NodeCrypt.js';
import { setupFileSend, handleFileMessage, downloadFile } from './util.file.js';
import { setupImagePaste } from './util.image.js';
import { setupEmojiPicker } from './util.emoji.js';
import { openSettingsPanel, closeSettingsPanel, initSettings, notifyMessage } from './util.settings.js';
import { t, updateStaticTexts } from './util.i18n.js';
import { initTheme } from './util.theme.js';
import { $, $id, removeClass } from './util.dom.js';
import { roomsData, activeRoomIndex, joinRoom } from './room.js';
import { addMsg, addOtherMsg, addSystemMsg, setupImagePreview, setupInputPlaceholder, autoGrowInput } from './chat.js';
import { renderUserList, renderMainHeader, setupMoreBtnMenu, preventSpaceInput, loginFormHandler, openLoginModal, setupTabs, autofillRoomPwd, initLoginForm, initFlipCard } from './ui.js';

// 全局配置
window.config = {
	wsAddress: `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`,
	debug: true
};

// 挂载全局
window.addSystemMsg = addSystemMsg;
window.addOtherMsg = addOtherMsg;
window.joinRoom = joinRoom;
window.notifyMessage = notifyMessage;
window.setupEmojiPicker = setupEmojiPicker;
window.handleFileMessage = handleFileMessage;
window.downloadFile = downloadFile;

// === 1. 暴力汉化与文本修复函数 ===
function fixUIText() {
	// 将“Node Name”替换为“房间号”
	const treeWalker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
	let node;
	while (node = treeWalker.nextNode()) {
		if (node.nodeValue && node.nodeValue.includes('Node')) {
			node.nodeValue = node.nodeValue.replace(/Node Name/g, '房间号').replace(/Node/g, '房间');
		}
	}
	// 修复登录按钮文本
	const joinBtn = document.querySelector('.join-room span');
	if (joinBtn) joinBtn.innerText = '加入房间';
}

// === 2. 核心鉴权与邀请逻辑 ===
async function checkInviteAndAuth() {
    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get('code');
    const roomFromUrl = urlParams.get('room');
    const needPwdFromUrl = urlParams.get('pwd') === '1';

    // A. 邀请链接进入
    if (window.location.pathname === '/join' && code) {
        try {
            const res = await fetch('/api/verify-invite', {
                method: 'POST', body: JSON.stringify({ code })
            });
            const data = await res.json();
            if (res.ok) {
                let redirectUrl = '/';
                if (data.room) redirectUrl += `?room=${encodeURIComponent(data.room)}`;
                if (data.needPwd) redirectUrl += `&pwd=1`;
                window.location.href = redirectUrl;
            } else {
                alert(data.error || '链接无效');
            }
        } catch (e) {}
        return;
    }

    // B. 管理员登录
    if (window.location.pathname === '/admin') {
        $id('admin-login-modal').style.display = 'flex';
        $id('admin-login-form').onsubmit = async (e) => {
            e.preventDefault();
            const pwd = $id('admin-pwd').value;
            try {
                const res = await fetch('/api/login', {
                    method: 'POST', body: JSON.stringify({ pwd })
                });
                if (res.ok) window.location.href = '/';
                else alert('密码错误');
            } catch (error) {}
        };
        return;
    }

    // C. 访客模式 (URL带房间号)
    if (roomFromUrl) {
        $id('login-container').style.display = 'none'; // 隐藏原登录框
        const guestModal = $id('guest-modal');
        guestModal.style.display = 'flex';
        $id('guest-welcome-title').innerText = `加入房间: ${decodeURIComponent(roomFromUrl)}`;
        
        if (needPwdFromUrl) {
            $id('guest-pwd-group').style.display = 'block';
            $id('guest-room-pwd').required = true;
        }

        $id('guest-login-form').onsubmit = (e) => {
            e.preventDefault();
            const nickname = $id('guest-nickname').value;
            const pwd = needPwdFromUrl ? $id('guest-room-pwd').value : '';
            guestModal.style.display = 'none';
            joinRoom(decodeURIComponent(roomFromUrl), nickname, pwd);
        };
        return;
    }

    // D. 普通模式：检查管理员权限显示按钮
    try {
        const res = await fetch('/api/check-auth');
        if (res.ok) {
            const data = await res.json();
            if (data.isAdmin) {
                // 显示所有管理员元素
                document.querySelectorAll('.admin-only').forEach(el => el.style.display = 'block');
            }
        }
    } catch (e) {}
}

// === 3. 邀请链接生成器 ===
function setupInviteGenerator() {
    const btn = $id('btn-create-invite');
    if (!btn) return;
    
    // 打开弹窗时自动填充当前房间名
    const inviteBtn = document.querySelector('.invite-fab');
    if(inviteBtn) {
        inviteBtn.addEventListener('click', () => {
             if (roomsData.length > 0 && activeRoomIndex >= 0) {
                $id('invite-room-name').value = roomsData[activeRoomIndex].name;
            }
        });
    }

    btn.onclick = async () => {
        const limit = parseInt($id('invite-limit').value) || 0;
        const note = $id('invite-note').value;
        const duration = parseInt($id('invite-duration').value) || 0;
        const roomName = $id('invite-room-name').value.trim();
        const needPwd = $id('invite-need-pwd').checked;
        const resultBox = $id('invite-result');
        
        btn.innerText = '生成中...'; btn.disabled = true;
        
        try {
            const res = await fetch('/api/admin/create-invite', {
                method: 'POST',
                body: JSON.stringify({ maxUses: limit, note, expireMinutes: duration, room: roomName, needPwd })
            });
            if (res.ok) {
                const data = await res.json();
                const inviteUrl = `${window.location.origin}/join?code=${data.code}`;
                resultBox.style.display = 'block';
                resultBox.innerHTML = `
                    <div class="share-result-info">链接已生成</div>
                    <a href="${inviteUrl}" target="_blank">${inviteUrl}</a>
                    <div class="share-result-info">
                        ${data.maxUses===0 ? '无限次' : `剩余 ${data.maxUses} 次`} | 
                        ${data.expireAt ? '有效期至 '+new Date(data.expireAt).toLocaleDateString() : '永久有效'}
                    </div>
                `;
            } else {
                resultBox.style.display = 'block'; resultBox.innerText = '生成失败';
            }
        } catch (e) {
            resultBox.style.display = 'block'; resultBox.innerText = '错误';
        }
        btn.innerText = '生成链接'; btn.disabled = false;
    };
}

// === 初始化流程 ===
window.addEventListener('DOMContentLoaded', async () => {
    await checkInviteAndAuth();

    if (window.location.pathname === '/admin' || window.location.pathname === '/join') return;

	setTimeout(() => { document.body.classList.remove('preload'); }, 300);
	initLoginForm();
    setupInviteGenerator();
	fixUIText(); // 强制修复文案

	const loginForm = $id('login-form');
	if (loginForm) loginForm.addEventListener('submit', loginFormHandler(null));

	const joinBtn = $('.join-room');
	if (joinBtn) joinBtn.onclick = openLoginModal;
    
	preventSpaceInput($id('userName'));
	preventSpaceInput($id('roomName'));
	preventSpaceInput($id('password'));
	
	initFlipCard();
	autofillRoomPwd();
	setupInputPlaceholder();
	setupMoreBtnMenu();
	setupImagePreview();
	setupEmojiPicker();
	initTheme();
	initSettings();
    updateStaticTexts();

    // 再次强制修复文案，防止 i18n 覆盖
    setInterval(fixUIText, 1000); // 简单粗暴，确保“Node”字样彻底消失
	
	// 绑定设置按钮
	const settingsBtn = $id('settings-btn');
	if (settingsBtn) settingsBtn.onclick = (e) => { e.stopPropagation(); openSettingsPanel(); };
	const settingsBackBtn = $id('settings-back-btn');
	if (settingsBackBtn) settingsBackBtn.onclick = (e) => { e.stopPropagation(); closeSettingsPanel(); };
	
    // 消息发送逻辑
	const input = document.querySelector('.input-message-input');
	const imagePasteHandler = setupImagePaste('.input-message-input');
	if (input) {
		input.focus();
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
		});
	}
	
	function sendMessage() {
		const text = input.innerText.trim();
		const images = imagePasteHandler ? imagePasteHandler.getCurrentImages() : [];
		if (!text && images.length === 0) return;
		const rd = roomsData[activeRoomIndex];
		if (rd && rd.chat) {
			const msgContent = images.length > 0 ? { text: text||'', images } : text;
            const type = images.length > 0 ? 'image' : 'text';
            
            if (rd.privateChatTargetId) {
                // 私聊逻辑
                const target = rd.chat.channel[rd.privateChatTargetId];
                if (target && target.shared) {
                    const payload = { a: 'm', t: type+'_private', d: msgContent };
                    const enc = rd.chat.encryptClientMessage(payload, target.shared);
                    rd.chat.sendMessage(rd.chat.encryptServerMessage({a:'c', p:enc, c:rd.privateChatTargetId}, rd.chat.serverShared));
                    addMsg(msgContent, false, type+'_private');
                } else addSystemMsg('发送失败');
            } else {
                // 群聊
                rd.chat.sendChannelMessage(type, msgContent);
                addMsg(msgContent, false, type);
            }
			if(images.length>0) imagePasteHandler.clearImages();
			input.innerHTML = '';
			autoGrowInput();
		}
	}
	
	const sendButton = document.querySelector('.send-message-btn');
	if (sendButton) sendButton.addEventListener('click', sendMessage);
    
    // 文件发送
	setupFileSend({
		inputSelector: '.input-message-input',
		attachBtnSelector: '.chat-attach-btn',
		fileInputSelector: '.new-message-wrapper input[type="file"]',
		onSend: (msg) => {
			const rd = roomsData[activeRoomIndex];
			if (rd && rd.chat) {
                // 简化文件发送逻辑...
				rd.chat.sendChannelMessage(msg.type, { ...msg, userName: rd.myUserName||'' });
				if (msg.type === 'file_start') addMsg(msg, false, 'file');
			}
		}
	});

	// 移动端处理
	const isMobile = () => window.innerWidth <= 768;
	renderMainHeader(); renderUserList(); setupTabs();
	const roomList = $id('room-list');
	if (roomList) roomList.addEventListener('click', () => { if (isMobile()) { $id('sidebar')?.classList.remove('mobile-open'); $id('mobile-sidebar-mask')?.classList.remove('active'); } });
});

// 监听语言变化，强制改回“房间”
window.addEventListener('languageChange', () => { updateStaticTexts(); fixUIText(); });
