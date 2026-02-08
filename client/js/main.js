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

// === 核心逻辑: 检查邀请、鉴权和访客模式 ===
async function checkInviteAndAuth() {
    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get('code');
    const roomFromUrl = urlParams.get('room');
    const needPwdFromUrl = urlParams.get('pwd') === '1';

    // 1. 邀请链接处理 /join?code=xxx
    if (window.location.pathname === '/join' && code) {
        try {
            const res = await fetch('/api/verify-invite', {
                method: 'POST',
                body: JSON.stringify({ code })
            });
            const data = await res.json();
            if (res.ok) {
                // 验证成功，跳转到首页，并携带房间信息
                let redirectUrl = '/';
                if (data.room) {
                    redirectUrl += `?room=${encodeURIComponent(data.room)}`;
                    if (data.needPwd) redirectUrl += `&pwd=1`;
                }
                window.location.href = redirectUrl;
            } else {
                alert(data.error || '链接无效');
            }
        } catch (e) {
            alert('验证出错');
        }
        return;
    }

    // 2. 管理员登录 /admin
    if (window.location.pathname === '/admin') {
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
                    window.location.href = '/';
                } else {
                    alert('密码错误');
                }
            } catch (error) { alert('请求失败'); }
        };
        return;
    }

    // 3. 访客自动弹窗逻辑
    // 如果 URL 中有 room 参数，说明是受邀访客
    if (roomFromUrl) {
        console.log('检测到访客模式，目标房间:', roomFromUrl);
        
        // 隐藏默认的翻转卡片
        const loginContainer = $id('login-container');
        if (loginContainer) loginContainer.style.display = 'none'; // 暂时隐藏，等下可能不需要显示
        
        // 显示极简访客弹窗
        const guestModal = $id('guest-modal');
        guestModal.style.display = 'flex';
        
        $id('guest-welcome-title').innerText = `加入房间: ${decodeURIComponent(roomFromUrl)}`;
        
        // 如果需要密码，显示密码框
        if (needPwdFromUrl) {
            $id('guest-pwd-group').style.display = 'block';
            $id('guest-room-pwd').required = true;
        }

        $id('guest-login-form').onsubmit = (e) => {
            e.preventDefault();
            const nickname = $id('guest-nickname').value;
            const pwd = needPwdFromUrl ? $id('guest-room-pwd').value : '';

            // 填充并提交原始表单逻辑 (利用现有 joinRoom 功能)
            // 这里我们模拟 loginFormHandler 的数据
            const roomName = decodeURIComponent(roomFromUrl);
            
            // 关闭模态框
            guestModal.style.display = 'none';
            // 显示主界面 loading (如果有的话)
            
            // 触发加入房间
            joinRoom(roomName, nickname, pwd);
        };
        return; // 结束，不执行默认的登录表单初始化
    }

    // 4. 正常管理员/用户逻辑，检查权限显示分享按钮
    try {
        const res = await fetch('/api/check-auth');
        if (res.ok) {
            const data = await res.json();
            if (data.isAdmin) {
                document.querySelectorAll('.admin-only').forEach(el => el.style.display = 'block');
            }
        }
    } catch (e) {}
}

// === 管理员：生成高级邀请链接 ===
function setupInviteGenerator() {
    const btn = $id('btn-create-invite');
    if (!btn) return;
    
    // 自动填充当前房间名 (如果已在房间内)
    const updateRoomPlaceholder = () => {
        if (roomsData.length > 0 && activeRoomIndex >= 0) {
            $id('invite-room-name').value = roomsData[activeRoomIndex].name;
        }
    };
    // 监听打开事件 (简单起见，点击生成按钮时才读取)
    
    btn.onclick = async () => {
        const limit = parseInt($id('invite-limit').value) || 0;
        const note = $id('invite-note').value;
        const duration = parseInt($id('invite-duration').value) || 0;
        const roomName = $id('invite-room-name').value.trim();
        const needPwd = $id('invite-need-pwd').checked;
        const resultBox = $id('invite-result');
        
        btn.innerText = '生成中...';
        btn.disabled = true;
        
        try {
            const res = await fetch('/api/admin/create-invite', {
                method: 'POST',
                body: JSON.stringify({ 
                    maxUses: limit, 
                    note,
                    expireMinutes: duration,
                    room: roomName,
                    needPwd
                })
            });
            
            if (res.ok) {
                const data = await res.json();
                const inviteUrl = `${window.location.origin}/join?code=${data.code}`;
                resultBox.style.display = 'block';
                resultBox.innerHTML = `
                    <div style="color:#aaa;font-size:12px;margin-bottom:5px;">链接已生成:</div>
                    <a href="${inviteUrl}" target="_blank">${inviteUrl}</a>
                    <div style="color:#666;font-size:12px;margin-top:5px;">
                        ${data.maxUses === 0 ? '无限次' : `剩余 ${data.maxUses} 次`} | 
                        ${data.expireAt ? new Date(data.expireAt).toLocaleString() + ' 过期' : '永久有效'}
                    </div>
                `;
            } else {
                resultBox.style.display = 'block';
                resultBox.innerText = '生成失败';
            }
        } catch (e) {
            resultBox.style.display = 'block';
            resultBox.innerText = '请求出错';
        }
        
        btn.innerText = '生成链接';
        btn.disabled = false;
    };
}


// DOM 加载完成
window.addEventListener('DOMContentLoaded', async () => {
    // 优先处理邀请和鉴权
    await checkInviteAndAuth();

    // 如果是 /admin 或 /join 页面，不需要初始化其他UI
    if (window.location.pathname === '/admin' || window.location.pathname === '/join') {
        return; 
    }

	setTimeout(() => { document.body.classList.remove('preload'); }, 300);
	initLoginForm();
    setupInviteGenerator(); // 初始化

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
