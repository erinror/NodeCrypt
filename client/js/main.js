// 导入 NodeCrypt 模块
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

// 初始化
initSettings();
updateStaticTexts();

// 挂载全局函数
window.addSystemMsg = addSystemMsg;
window.addOtherMsg = addOtherMsg;
window.joinRoom = joinRoom;
window.notifyMessage = notifyMessage;
window.setupEmojiPicker = setupEmojiPicker;
window.handleFileMessage = handleFileMessage;
window.downloadFile = downloadFile;

// === 新增：邀请和管理逻辑 ===
async function checkInviteAndAuth() {
    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get('code');

    // 1. 如果是邀请链接 /join?code=xxx
    if (window.location.pathname === '/join' && code) {
        try {
            const res = await fetch('/api/verify-invite', {
                method: 'POST',
                body: JSON.stringify({ code })
            });
            const data = await res.json();
            if (res.ok) {
                // 验证成功，Cookie 已自动写入，重定向到首页
                window.location.href = '/';
            } else {
                alert('邀请链接无效或已过期！');
                // 失败不跳转，就停留在当前页面（此时是伪装的 index.html，但因为没有 auth，WS 会连不上）
            }
        } catch (e) {
            alert('验证失败');
        }
        return;
    }

    // 2. 如果是管理员入口 /admin
    if (window.location.pathname === '/admin') {
        // 显示登录弹窗
        $id('admin-login-modal').style.display = 'flex';
        
        $id('admin-login-form').onsubmit = async (e) => {
            e.preventDefault();
            const pwd = $id('admin-pwd').value;
            try {
                const res = await fetch('/api/login', {
                    method: 'POST',
                    body: JSON.stringify({ pwd })
                });
                if (res.ok) {
                    // 登录成功，重定向到首页
                    window.location.href = '/';
                } else {
                    alert('密码错误');
                }
            } catch (error) {
                alert('登录请求失败');
            }
        };
        return; // 停止后续初始化，等待登录
    }

    // 3. 正常进入，检查是否为管理员以显示“邀请按钮”
    try {
        const res = await fetch('/api/check-auth');
        if (res.ok) {
            const data = await res.json();
            if (data.isAdmin) {
                // 显示设置里的邀请按钮
                const adminGroups = document.querySelectorAll('.admin-only');
                adminGroups.forEach(el => el.style.display = 'block');
            }
        }
    } catch (e) {}
}

// === 新增：邀请生成逻辑 ===
function setupInviteGenerator() {
    const btn = $id('btn-create-invite');
    if (!btn) return;
    
    btn.onclick = async () => {
        const limit = parseInt($id('invite-limit').value) || 0;
        const note = $id('invite-note').value;
        const resultBox = $id('invite-result');
        
        btn.innerText = '生成中...';
        btn.disabled = true;
        
        try {
            const res = await fetch('/api/admin/create-invite', {
                method: 'POST',
                body: JSON.stringify({ maxUses: limit, note })
            });
            
            if (res.ok) {
                const data = await res.json();
                const inviteUrl = `${window.location.origin}/join?code=${data.code}`;
                resultBox.style.display = 'block';
                resultBox.innerHTML = `
                    <div style="color:#aaa;font-size:12px;margin-bottom:5px;">链接已生成:</div>
                    <a href="${inviteUrl}" target="_blank">${inviteUrl}</a>
                    <div style="color:#666;font-size:12px;margin-top:5px;">
                        剩余次数: ${data.maxUses === 0 ? '无限' : data.maxUses}
                    </div>
                `;
            } else {
                resultBox.style.display = 'block';
                resultBox.innerText = '生成失败，请确认是否已登录';
            }
        } catch (e) {
            resultBox.style.display = 'block';
            resultBox.innerText = '请求出错';
        }
        
        btn.innerText = '生成';
        btn.disabled = false;
    };
}


// DOM 加载完成
window.addEventListener('DOMContentLoaded', async () => {
    // 先检查权限和路由逻辑
    await checkInviteAndAuth();

    // 如果在 /admin 或 /join 页面，不初始化聊天逻辑，避免报错
    if (window.location.pathname === '/admin' || window.location.pathname === '/join') {
        return; 
    }

	setTimeout(() => { document.body.classList.remove('preload'); }, 300);
	initLoginForm();
    setupInviteGenerator(); // 初始化邀请生成器监听

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
	
	const settingsBtn = $id('settings-btn');
	if (settingsBtn) {
		settingsBtn.onclick = (e) => {
			e.stopPropagation();
			openSettingsPanel();
		}
	}

	const settingsBackBtn = $id('settings-back-btn');
	if (settingsBackBtn) {
		settingsBackBtn.onclick = (e) => {
			e.stopPropagation();
			closeSettingsPanel();
		}
	}
	
	// 消息输入和发送逻辑
	const input = document.querySelector('.input-message-input');
	const imagePasteHandler = setupImagePaste('.input-message-input');
	
	if (input) {
		input.focus();
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				sendMessage();
			}
		});
	}
	
	function sendMessage() {
		const text = input.innerText.trim();
		const images = imagePasteHandler ? imagePasteHandler.getCurrentImages() : [];

		if (!text && images.length === 0) return;
		const rd = roomsData[activeRoomIndex];
		
		if (rd && rd.chat) {
			if (images.length > 0) {
				const messageContent = { text: text || '', images: images };
				if (rd.privateChatTargetId) {
					const targetClient = rd.chat.channel[rd.privateChatTargetId];
					if (targetClient && targetClient.shared) {
						const clientPayload = { a: 'm', t: 'image_private', d: messageContent };
						const encClient = rd.chat.encryptClientMessage(clientPayload, targetClient.shared);
						const serverPayload = { a: 'c', p: encClient, c: rd.privateChatTargetId };
						rd.chat.sendMessage(rd.chat.encryptServerMessage(serverPayload, rd.chat.serverShared));
						addMsg(messageContent, false, 'image_private');
					} else {
						addSystemMsg(`${t('system.private_message_failed')} ${rd.privateChatTargetName}.`);
					}
				} else {
					rd.chat.sendChannelMessage('image', messageContent);
					addMsg(messageContent, false, 'image');
				}
				imagePasteHandler.clearImages();
			} else if (text) {
				if (rd.privateChatTargetId) {
					const targetClient = rd.chat.channel[rd.privateChatTargetId];
					if (targetClient && targetClient.shared) {
						const clientPayload = { a: 'm', t: 'text_private', d: text };
						const encClient = rd.chat.encryptClientMessage(clientPayload, targetClient.shared);
						const serverPayload = { a: 'c', p: encClient, c: rd.privateChatTargetId };
						rd.chat.sendMessage(rd.chat.encryptServerMessage(serverPayload, rd.chat.serverShared));
						addMsg(text, false, 'text_private');
					} else {
						addSystemMsg(`${t('system.private_message_failed')} ${rd.privateChatTargetName}.`);
					}
				} else {
					rd.chat.sendChannelMessage('text', text);
					addMsg(text);
				}
			}
			input.innerHTML = '';
			if (imagePasteHandler && typeof imagePasteHandler.refreshPlaceholder === 'function') {
				imagePasteHandler.refreshPlaceholder();
			}
			autoGrowInput();
		}
	}
	
	const sendButton = document.querySelector('.send-message-btn');
	if (sendButton) sendButton.addEventListener('click', sendMessage);
	
	setupFileSend({
		inputSelector: '.input-message-input',
		attachBtnSelector: '.chat-attach-btn',
		fileInputSelector: '.new-message-wrapper input[type="file"]',
		onSend: (message) => {
			const rd = roomsData[activeRoomIndex];
			if (rd && rd.chat) {
				const userName = rd.myUserName || '';
				const msgWithUser = { ...message, userName };
				if (rd.privateChatTargetId) {
					const targetClient = rd.chat.channel[rd.privateChatTargetId];
					if (targetClient && targetClient.shared) {
						const clientPayload = { a: 'm', t: msgWithUser.type + '_private', d: msgWithUser };
						const encClient = rd.chat.encryptClientMessage(clientPayload, targetClient.shared);
						const serverPayload = { a: 'c', p: encClient, c: rd.privateChatTargetId };
						rd.chat.sendMessage(rd.chat.encryptServerMessage(serverPayload, rd.chat.serverShared));
						if (msgWithUser.type === 'file_start') addMsg(msgWithUser, false, 'file_private');
					} else {
						addSystemMsg(`${t('system.private_file_failed')} ${rd.privateChatTargetName}.`);
					}
				} else {
					rd.chat.sendChannelMessage(msgWithUser.type, msgWithUser);
					if (msgWithUser.type === 'file_start') addMsg(msgWithUser, false, 'file');
				}
			}
		}
	});

	const isMobile = () => window.innerWidth <= 768;
	renderMainHeader();
	renderUserList();
	setupTabs();

	const roomList = $id('room-list');
	const sidebar = $id('sidebar');
	const rightbar = $id('rightbar');
	const sidebarMask = $id('mobile-sidebar-mask');
	const rightbarMask = $id('mobile-rightbar-mask');

	if (roomList) {
		roomList.addEventListener('click', () => {
			if (isMobile()) {
				sidebar?.classList.remove('mobile-open');
				sidebarMask?.classList.remove('active');
			}
		});
	}

	const memberTabs = $id('member-tabs');
	if (memberTabs) {
		memberTabs.addEventListener('click', () => {
			if (isMobile()) {
				removeClass(rightbar, 'mobile-open');
				removeClass(rightbarMask, 'active');
			}
		});
	}
});

// 监听语言切换
window.addEventListener('languageChange', () => { updateStaticTexts(); });

// 拖拽上传
let dragCounter = 0;
let hasTriggeredAttach = false;
window.addEventListener('fileUploadModalClosed', () => { hasTriggeredAttach = false; });
document.addEventListener('dragenter', (e) => {
	dragCounter++;
	if (!hasTriggeredAttach && e.dataTransfer.items.length > 0) {
		for (let item of e.dataTransfer.items) {
			if (item.kind === 'file') {
				const attachBtn = document.querySelector('.chat-attach-btn');
				if (attachBtn) { attachBtn.click(); hasTriggeredAttach = true; }
				break;
			}
		}
	}
});
document.addEventListener('dragleave', () => {
	dragCounter--;
	if (dragCounter === 0) hasTriggeredAttach = false;
});
document.addEventListener('dragover', (e) => { e.preventDefault(); });
document.addEventListener('drop', (e) => { e.preventDefault(); dragCounter = 0; hasTriggeredAttach = false; });
