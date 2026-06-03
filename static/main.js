// =============================================================================
// AI海龟汤聊天室 - 前端 JavaScript
// 原作者: mumuhaha (https://github.com/mumuhaha487/Turtle_Soup)
// =============================================================================
// 【凯喵推子 / 全AI修改】以下功能由 Claude Code 生成:
//   - API 配置本地管理（localStorage CRUD + UI 弹窗）
//   - 智能问题库面板
//   - AI 生成故事弹窗 + 多轮微调界面
//   - 改造创建房间流程（使用本地 API 配置）
//   - AI 消息发送支持问题库缓存命中与提示
// =============================================================================

// 页面切换
function showPage(page) {
    document.getElementById('page-home').style.display = page === 'home' ? '' : 'none';
    document.getElementById('page-create').style.display = page === 'create' ? '' : 'none';
    document.getElementById('page-join').style.display = page === 'join' ? '' : 'none';
    document.getElementById('page-chat').style.display = page === 'chat' ? '' : 'none';
    if (page === 'chat') {
        document.getElementById('user-input').focus();
    }
}

document.addEventListener('DOMContentLoaded', function() {
// 全局状态
let roomCode = '';
let nickname = '';
let isOwner = false;
let polling = null;
let isUploading = false;
// 当前题目信息缓存
let currentStoryInfo = null;
let isAnswerRevealed = false;
// ========== 无AI群聊相关 ==========
let chatPolling = null;
let onlinePolling = null;
let sendBtn;
let createBtn;
createBtn = document.getElementById('create-room-btn');
let joinBtn;
// 加入房间
joinBtn = document.getElementById('join-room-btn');
joinBtn.onclick = async function() {
    const nick = document.getElementById('join-nickname').value.trim();
    const code = document.getElementById('join-code').value.trim().toUpperCase();
    if (!nick || !code) {
        document.getElementById('join-error').textContent = '请填写完整信息';
        return;
    }
    joinBtn.disabled = true;
    document.getElementById('join-error').textContent = '';
    try {
        const res = await fetch('/api/join_room', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({nickname: nick, code})
        });
        const data = await res.json();
        if (data.success) {
            roomCode = code;
            nickname = nick;
            isOwner = false;
            enterChat(data.room);
        } else {
            document.getElementById('join-error').textContent = data.error || '加入失败';
        }
    } catch (e) {
        document.getElementById('join-error').textContent = '网络错误';
    }
    joinBtn.disabled = false;
};

// 发送消息
sendBtn = document.getElementById('send-btn');
sendBtn.onclick = async function() {
    const content = document.getElementById('user-input').value.trim();
    if (!content) return;
    sendBtn.disabled = true;
    document.getElementById('user-input').disabled = true;
    try {
        await sendAIMessage(content);
        document.getElementById('user-input').value = '';
    } catch (e) {}
    sendBtn.disabled = false;
    document.getElementById('user-input').disabled = false;
    document.getElementById('user-input').focus();
};

document.getElementById('user-input').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
        sendBtn.click();
    }
});

// 轮询消息
function startPolling() {
    if (polling) clearInterval(polling);
    pollMessages();
    polling = setInterval(pollMessages, 2000);
}
async function pollMessages() {
    if (!roomCode) return;
    try {
        const res = await fetch('/api/get_messages', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({code: roomCode})
        });
        const data = await res.json();
        if (data.messages) {
            renderMessages(data.messages);
        }
        // 新增：全房间弹窗过关
        if (data.passed && !window._popupPassedFlag) {
            window._popupPassedFlag = true;
            showPopup('恭喜过关');
        }
    } catch (e) {}
}
function renderMessages(msgs) {
    const chatBox = document.getElementById('chat-box');
    const isAtBottom = chatBox.scrollTop + chatBox.clientHeight >= chatBox.scrollHeight - 10;
    chatBox.innerHTML = '';
    for (const msg of msgs) {
        if (msg.role === 'system') {
            const div = document.createElement('div');
            div.style = 'text-align:center;color:#94a3b8;font-size:13px;margin:6px 0;';
            div.innerHTML = escapeHtml(msg.content);
            chatBox.appendChild(div);
            continue;
        }
        const div = document.createElement('div');
        div.className = 'bubble ' + (msg.role === 'user' ? 'msg-user' : 'msg-ai');
        let nicknameHtml = `<span class=\"msg-nickname\">${msg.nickname}</span>`;
        // 【凯喵推子】检测 from_cache 标记，显示「📚 问题库」标签
        if (msg.from_cache) {
            nicknameHtml += ` <span style="display:inline-block;font-size:11px;background:#fef3c7;color:#92400e;padding:1px 6px;border-radius:4px;font-weight:600;">📚 问题库</span>`;
        }
        // 【凯喵推子】检测是否为 AI 错误消息，用红色标注
        if (msg.content && msg.content.startsWith('[AI错误]')) {
            div.style.border = '1px solid #fca5a5';
        }
        div.innerHTML = `${nicknameHtml}: ${escapeHtml(msg.content)}`;
        chatBox.appendChild(div);
    }
    if (isAtBottom) {
        chatBox.scrollTop = chatBox.scrollHeight;
    }
}
function escapeHtml(text) {
    if (!text) return '';
    return text.replace(/[&<>"']/g, function(c) {
        return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    }).replace(/\n/g, '<br>');
}

// 删除房间
const deleteBtn = document.getElementById('delete-room-btn');
deleteBtn.onclick = async function() {
    if (!confirm('确定要删除房间吗？')) return;
    try {
        await fetch('/api/delete_room', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({code: roomCode, nickname})
        });
        alert('房间已删除');
        leaveRoom();
    } catch (e) {}
};

// 退出房间
window.leaveRoom = function() {
    if (polling) clearInterval(polling);
    roomCode = '';
    nickname = '';
    isOwner = false;
    localStorage.removeItem('haigui_room');
    showPage('home');
}

// 新增：上传题目、切换题目、显示当前题面
function renderStory(story) {
    currentStoryInfo = story;
    isAnswerRevealed = !!(story && story.answer && story.answer.length > 0);
    const storyDiv = document.getElementById('current-story');
    let html = '';
    if (!story) {
        html = '<em>暂无题目，请房主上传海龟汤题目</em>';
    } else {
        html += `<div style=\"margin-bottom:8px;\">${escapeHtml(story.surface || '')}</div>`;
        // 删除揭晓答案的显示，只在聊天框中显示
    }
    // 房主操作区
    if (isOwner && story) {
        html += `<div style=\"margin-top:10px;\">`;
        if (!story.answer || story.answer.length === 0) {
            html += `<button class=\"btn\" id=\"reveal-answer-btn\">揭晓答案</button>`;
        }
        html += `</div>`;
    }
    storyDiv.innerHTML = html;
    // 绑定房主操作按钮
    if (isOwner && story) {
        const revealBtn = document.getElementById('reveal-answer-btn');
        if (revealBtn) {
            revealBtn.onclick = async function() {
                if (!confirm('确定要揭晓答案吗？')) return;
                await fetch('/api/reveal_answer', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({code: roomCode, nickname})
                });
                fetchCurrentStory();
            };
        }
    }
}

// 新增：从故事广场加载故事
async function loadStoryFromPlaza(filename) {
    try {
        const response = await fetch('/api/load_story_from_plaza', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({code: roomCode, nickname, filename})
        });
        const data = await response.json();
        if (data.success) {
            alert('故事加载成功');
            fetchCurrentStory();
            fetchStoryList && fetchStoryList();
        } else {
            alert('加载失败：' + (data.error || '未知错误'));
        }
    } catch (error) {
        alert('加载失败：网络错误');
    }
}

// 新增：获取故事广场列表
async function getPlazaStories() {
    try {
        const response = await fetch('/api/get_plaza_stories');
        const data = await response.json();
        return data.stories;
    } catch (error) {
        console.error('获取故事广场失败:', error);
        return [];
    }
}

// 新增：显示故事广场选择窗口（美化弹窗+下拉）
async function showPlazaStorySelector() {
    const stories = await getPlazaStories();
    if (stories.length === 0) {
        alert('故事广场暂无故事');
        return;
    }
    // 构建弹窗
    let modal = document.getElementById('plaza-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'plaza-modal';
        modal.style = 'display:flex;position:fixed;left:0;top:0;width:100vw;height:100vh;background:rgba(0,0,0,0.18);z-index:999;align-items:center;justify-content:center;';
        modal.innerHTML = `
        <div style="background:#fff;padding:32px 24px;border-radius:16px;box-shadow:0 8px 32px 0 rgba(31,38,135,0.15);max-width:340px;width:90vw;">
            <h3 style="color:#3b82f6;text-align:center;margin-bottom:18px;">从故事广场加载</h3>
            <form id="plaza-select-form">
                <div class="form-group">
                    <label>选择故事编号</label>
                    <select id="plaza-story-select" style="width:100%;padding:8px 6px;border-radius:8px;border:1.5px solid #cbd5e1;font-size:15px;background:#f8fafc;">
                        ${stories.map(story => `<option value="${story.filename}">${story.name} ${story.id}</option>`).join('')}
                    </select>
                </div>
                <div class="form-group">
                    <label>或直接输入编号</label>
                    <input type="text" id="plaza-story-input" placeholder="如: #00001" style="width:100%;padding:8px 6px;border-radius:8px;border:1.5px solid #cbd5e1;font-size:15px;background:#f8fafc;">
                    <div id="plaza-story-match" style="margin-top:4px;font-size:13px;color:#64748b;"></div>
                </div>
                <button class="btn start-btn" type="submit" style="width:100%;margin-top:10px;">加载</button>
                <button class="btn" type="button" onclick="closePlazaModal()" style="width:100%;background:#e5e7eb;color:#334155;margin-top:8px;">取消</button>
            </form>
            <div id="plaza-select-result" style="margin-top:10px;"></div>
        </div>`;
        document.body.appendChild(modal);
        window.closePlazaModal = function() { modal.style.display = 'none'; };
        
        // 输入编号时自动匹配
        const input = modal.querySelector('#plaza-story-input');
        const matchDiv = modal.querySelector('#plaza-story-match');
        input.addEventListener('input', function() {
            const inputValue = this.value.trim();
            if (inputValue) {
                const matchedStory = stories.find(story => story.id === inputValue);
                if (matchedStory) {
                    matchDiv.innerHTML = `匹配到: ${matchedStory.name}`;
                    matchDiv.style.color = '#10b981';
                } else {
                    matchDiv.innerHTML = '未找到该编号的故事';
                    matchDiv.style.color = '#f87171';
                }
            } else {
                matchDiv.innerHTML = '';
            }
        });
        
        document.getElementById('plaza-select-form').onsubmit = async function(e) {
            e.preventDefault();
            const filename = document.getElementById('plaza-story-select').value;
            const inputValue = document.getElementById('plaza-story-input').value.trim();
            let targetFilename = filename;
            
            // 如果输入了编号，优先使用输入的编号
            if (inputValue) {
                const matchedStory = stories.find(story => story.id === inputValue);
                if (matchedStory) {
                    targetFilename = matchedStory.filename;
                } else {
                    document.getElementById('plaza-select-result').innerHTML = '<div class="error">未找到该编号的故事</div>';
                    return;
                }
            }
            
            if (!targetFilename) return;
            try {
                const response = await fetch('/api/load_story_from_plaza', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({code: roomCode, nickname, filename: targetFilename})
                });
                const data = await response.json();
                if (data.success) {
                    alert('故事加载成功');
                    closePlazaModal();
                    fetchCurrentStory();
                    fetchStoryList && fetchStoryList();
                } else {
                    document.getElementById('plaza-select-result').innerHTML = '<div class="error">' + (data.error || '加载失败') + '</div>';
                }
            } catch (error) {
                document.getElementById('plaza-select-result').innerHTML = '<div class="error">网络错误</div>';
            }
        };
    } else {
        // 刷新下拉选项
        const select = modal.querySelector('#plaza-story-select');
        select.innerHTML = stories.map(story => `<option value="${story.filename}">${story.name} ${story.id}</option>`).join('');
        modal.style.display = 'flex';
    }
    modal.style.display = 'flex';
}

// 修复上传题目按钮
function setupUploadBtn() {
    const storyOps = document.getElementById('story-ops');
    if (!storyOps) return;
    storyOps.innerHTML = `
        <div style="margin-bottom: 12px;">
            <input type="file" id="story-file" accept=".json" multiple style="display:none;">
            <button class="btn" id="upload-story-btn">上传题目 (json)</button>
            <button class="btn" id="load-plaza-btn">从故事广场加载</button>
            <div style="color: #64748b; font-size: 12px; margin-top: 4px;">文件大小不能超过20MB</div>
        </div>
        <div id="story-list" style="margin-bottom: 12px;"></div>
    `;
    document.getElementById('upload-story-btn').onclick = function() {
        document.getElementById('story-file').click();
    };
    document.getElementById('load-plaza-btn').onclick = function() {
        showPlazaStorySelector();
    };
    document.getElementById('story-file').onchange = async function() {
        if (isUploading) return;
        isUploading = true;
        const files = this.files;
        if (files.length === 0) {
            isUploading = false;
            return;
        }
        const formData = new FormData();
        for (let file of files) {
            formData.append('file', file);
        }
        formData.append('code', roomCode);
        formData.append('nickname', nickname);
        try {
            const res = await fetch('/api/upload_story', {
                method: 'POST',
                body: formData
            });
            const data = await res.json();
            if (data.success) {
                alert(`上传成功，共${data.count}个题目`);
                fetchCurrentStory();
                fetchStoryList && fetchStoryList();
            } else {
                alert('上传失败：' + (data.error || '未知错误'));
            }
        } catch (e) {
            alert('上传失败：网络错误');
        }
        isUploading = false;
        this.value = '';
    };
}

// 获取题库列表并渲染切换下拉框
async function fetchStoryList() {
    if (!roomCode || !isOwner) return;
    try {
        const res = await fetch('/api/get_current_story', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({code: roomCode})
        });
        // 题库数量通过上传后返回的count，前端需维护
        // 这里简化为每次上传/切换后刷新页面即可
    } catch (e) {}
}

// 切换题目
async function setStoryIndex(idx) {
    if (!roomCode || !isOwner) return;
    try {
        const res = await fetch('/api/set_story', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({code: roomCode, nickname, index: idx})
        });
        const data = await res.json();
        if (data.success) {
            await fetchCurrentStory();
            await pollMessages();
            saveSession();
        } else {
            alert(data.error || '切换失败');
        }
    } catch (e) {
        alert('切换失败');
    }
}

// 获取当前故事信息
async function fetchCurrentStory() {
    if (!roomCode) return;
    try {
        const res = await fetch('/api/get_current_story', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({code: roomCode})
        });
        const data = await res.json();
        if (data.surface !== undefined) {
            renderStory({surface: data.surface, victory_condition: data.victory_condition, answer: data.answer});
        } else {
            renderStory(null);
        }
    } catch (e) {
        renderStory(null);
    }
}

// 页面初始化，插入题目上传和切换控件
(function(){
    const chatPage = document.getElementById('page-chat');
    const storyOps = document.createElement('div');
    storyOps.id = 'story-ops';
    storyOps.style = 'margin-bottom:12px;display:none;text-align:center;';
    chatPage.insertBefore(storyOps, chatPage.firstChild);
    // 当前题目展示区
    const storyDiv = document.createElement('div');
    storyDiv.id = 'current-story';
    storyDiv.style = 'background:#f1f5f9;border-radius:10px;padding:12px 10px;margin-bottom:12px;min-height:48px;';
    chatPage.insertBefore(storyDiv, storyOps.nextSibling);
})();

// 保持刷新后页面还在群聊页
function saveSession() {
    if (roomCode && nickname) {
        localStorage.setItem('haigui_room', JSON.stringify({roomCode, nickname, isOwner}));
    }
}
function loadSession() {
    const data = localStorage.getItem('haigui_room');
    if (data) {
        try {
            const obj = JSON.parse(data);
            roomCode = obj.roomCode;
            nickname = obj.nickname;
            isOwner = obj.isOwner;
            enterChat();
        } catch (e) {}
    }
}

// 页面加载时自动恢复
window.addEventListener('DOMContentLoaded', loadSession);

// 默认显示首页
showPage('home');

let leaveRoomBtn;
leaveRoomBtn = document.querySelector('button[onclick="leaveRoom()"]');
if (leaveRoomBtn) {
    leaveRoomBtn.onclick = function() { leaveRoom(); };
}

// 公告侧栏渲染
(async function renderAnnouncements(){
    try {
        const resp = await fetch('/api/get_announcements');
        const data = await resp.json();
        const content = (data && data.content) ? data.content : '';
        // 在左侧创建公告栏
        let left = document.getElementById('announcement-panel');
        if (!left) {
            left = document.createElement('div');
            left.id = 'announcement-panel';
            left.style.background = '#fff';
            left.style.border = '3px solid #000';
            left.style.borderRadius = '0';
            left.style.padding = '10px 12px 10px 12px';
            left.style.marginTop = '48px';
            left.style.maxWidth = '320px';
            left.style.minWidth = '220px';
            left.style.marginRight = '16px';
            left.style.position = 'relative';
            left.style.fontFamily = '"Courier New", monospace';

            // 添加阴影效果
            left.innerHTML = '<div style="position:absolute;top:-3px;left:-3px;right:-3px;bottom:-3px;background:#000;z-index:-1;transform:translate(6px,6px);"></div>';

            // 将公告栏插入到主布局最左侧
            const layout = document.querySelector('.main-layout');
            if (layout) layout.insertBefore(left, layout.firstChild);
        }
        left.innerHTML = '<div style="position:absolute;top:-3px;left:-3px;right:-3px;bottom:-3px;background:#000;z-index:-1;transform:translate(6px,6px);"></div>' +
            '<div style="font-size:15px;color:#000;font-weight:bold;margin-bottom:6px;font-family:\'Courier New\',monospace;">公告</div>' +
            '<div style="white-space:pre-wrap;color:#000;line-height:1.6;font-family:\'Courier New\',monospace;">' + (content ? escapeHtml(content) : '暂无公告') + '</div>';
    } catch (e) {}
})();

// 【凯喵推子 / 全AI修改】移除原下拉选项初始化（旧版"高级API设置"已删除）
// API 配置改为从 localStorage 读取，通过首页「API 配置」管理
// ==============================
// 【凯喵推子 / 全AI修改】API 配置本地管理 (localStorage) — 数据层
// 功能: 用户在本机（浏览器）管理多套 API 配置
//       配置数据持久化在 localStorage key 'haigui_api_profiles'
//       多配置排序即故障转移优先级
// 数据格式: [{ id, name, base_url, api_key, model }]
// 重要: 数据函数必须放在最前面，给后面的 IIFE checkApiSetup 使用
// ==============================
const API_PROFILES_KEY = 'haigui_api_profiles';

function getApiProfiles() {
    return JSON.parse(localStorage.getItem(API_PROFILES_KEY) || '[]');
}
function saveApiProfiles(profiles) {
    localStorage.setItem(API_PROFILES_KEY, JSON.stringify(profiles));
    // 同步到服务端 session（异步，不阻塞）
    fetch('/api/save_my_config', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({profiles: profiles})
    }).catch(function() {});
}
function addApiProfile(profile) {
    const profiles = getApiProfiles();
    profile.id = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    profiles.push(profile);
    saveApiProfiles(profiles);
    return profile;
}
function updateApiProfile(id, data) {
    const profiles = getApiProfiles();
    const idx = profiles.findIndex(p => p.id === id);
    if (idx !== -1) {
        profiles[idx] = {...profiles[idx], ...data};
        saveApiProfiles(profiles);
    }
}
function deleteApiProfile(id) {
    let profiles = getApiProfiles();
    profiles = profiles.filter(p => p.id !== id);
    saveApiProfiles(profiles);
}
window.moveApiProfile = function(fromIdx, toIdx) {
    let profiles = getApiProfiles();
    if (fromIdx < 0 || fromIdx >= profiles.length || toIdx < 0 || toIdx >= profiles.length) return;
    let tmp = profiles[fromIdx];
    profiles[fromIdx] = profiles[toIdx];
    profiles[toIdx] = tmp;
    saveApiProfiles(profiles);
    renderApiProfileList();
};

// 检查用户是否已有 API 配置，若无则显示提示
(function checkApiSetup() {
    const profiles = getApiProfiles();
    if (profiles.length === 0) {
        const err = document.getElementById('create-error');
        if (err) err.textContent = '💡 请先点击首页「API 配置」按钮添加 API 配置';
    }
})();
// Restore from server session if local is empty
(function restoreFromServer() {
    fetch('/api/load_my_config').then(function(r){return r.json();}).then(function(data){
        if (data.profiles && data.profiles.length > 0 && getApiProfiles().length === 0) {
            localStorage.setItem('haigui_api_profiles', JSON.stringify(data.profiles));
            var err = document.getElementById('create-error');
            if (err) err.textContent = '';
        }
    }).catch(function(){});
})();

function renderChatMessages(msgs) {
    const box = document.getElementById('chat-box-chat');
    box.innerHTML = '';
    for (const msg of msgs) {
        let html = `<span class='msg-nickname' style='color:#3b82f6;'>${escapeHtml(msg.nickname)}</span>: `;
        let content = escapeHtml(msg.content);
        // @高亮
        const users = (currentOnlineUsers || []);
        users.forEach(u => {
            if (u && content.includes('@' + u)) {
                content = content.replaceAll('@' + u, `<span style='background:yellow;color:#d97706;padding:1px 4px;border-radius:4px;'>@${u}</span>`);
            }
        });
        html += content;
        const div = document.createElement('div');
        div.style = 'margin:2px 0;line-height:1.7;';
        div.innerHTML = html;
        box.appendChild(div);
    }
    box.scrollTop = box.scrollHeight;
}

let currentOnlineUsers = [];
function renderOnlineUsers(users) {
    currentOnlineUsers = users;
    // 渲染新用户列表
    const userList = document.getElementById('user-list');
    userList.innerHTML = '';
    users.forEach(u => {
        const div = document.createElement('div');
        div.style = 'display:flex;align-items:center;padding:6px 16px 6px 12px;margin-bottom:2px;border-radius:8px;transition:background 0.2s;cursor:pointer;';
        if (u === nickname) {
            div.style.background = '#dbeafe';
        } else {
            div.onmouseover = () => div.style.background = '#e0e7ff';
            div.onmouseout = () => div.style.background = '';
        }
        // 头像（首字母圆形）
        const avatar = document.createElement('div');
        avatar.textContent = u[0].toUpperCase();
        avatar.style = 'width:32px;height:32px;background:#3b82f6;color:#fff;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:bold;font-size:18px;margin-right:10px;box-shadow:0 2px 8px 0 rgba(59,130,246,0.08);';
        div.appendChild(avatar);
        // 昵称
        const nameSpan = document.createElement('span');
        nameSpan.textContent = u;
        nameSpan.style = 'font-size:15px;font-weight:500;color:#334155;';
        div.appendChild(nameSpan);
        // 标签
        const tag = document.createElement('span');
        tag.style = 'margin-left:10px;padding:2px 8px;border-radius:8px;font-size:12px;font-weight:bold;';
        if (u === window.roomOwner) {
            tag.textContent = '房主';
            tag.style.background = '#fef3c7';
            tag.style.color = '#b45309';
        } else {
            tag.textContent = '成员';
            tag.style.background = '#e0e7ff';
            tag.style.color = '#2563eb';
        }
        div.appendChild(tag);
        userList.appendChild(div);
    });
}

async function pollChatMessages() {
    if (!roomCode) return;
    try {
        const res = await fetch('/api/get_chat_messages', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({code: roomCode})
        });
        const data = await res.json();
        if (data.messages) renderChatMessages(data.messages);
    } catch (e) {}
}

async function pollOnlineUsers() {
    if (!roomCode) return;
    try {
        const res = await fetch('/api/get_online_users', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({code: roomCode})
        });
        const data = await res.json();
        if (data.users) renderOnlineUsers(data.users);
    } catch (e) {}
}

// 发送无AI群聊消息
const chatSendBtn = document.getElementById('chat-send-btn');
chatSendBtn.onclick = async function() {
    const input = document.getElementById('chat-input');
    const content = input.value.trim();
    if (!content) return;
    chatSendBtn.disabled = true;
    input.disabled = true;
    try {
        await fetch('/api/send_chat_message', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({code: roomCode, nickname, content})
        });
        input.value = '';
        await pollChatMessages();
    } catch (e) {}
    chatSendBtn.disabled = false;
    input.disabled = false;
    input.focus();
};
document.getElementById('chat-input').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
        chatSendBtn.click();
    }
});

// 聊天输入框（固定高度，用户可手动拖动）
const userInput = document.getElementById('user-input');
if (userInput) {
    userInput.setAttribute('rows', '3');
    userInput.setAttribute('style', 'resize:vertical;min-height:60px;max-height:150px;');
}

// 心跳机制
function startHeartbeat() {
    setInterval(async () => {
        if (!roomCode || !nickname) return;
        await fetch('/api/heartbeat', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({code: roomCode, nickname})
        });
    }, 30000);
} 

// 通用 toast 通知（替换 alert）
function showToast(msg, type) {
    type = type || 'info';
    let toast = document.createElement('div');
    toast.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);z-index:10000;padding:12px 24px;border-radius:12px;font-size:14px;font-weight:600;box-shadow:0 4px 20px rgba(0,0,0,0.15);transition:opacity 0.3s;max-width:80vw;text-align:center;';
    if (type === 'error') { toast.style.background = '#fef2f2'; toast.style.color = '#b91c1c'; toast.style.border = '1px solid #fecaca'; }
    else if (type === 'success') { toast.style.background = '#f0fdf4'; toast.style.color = '#059669'; toast.style.border = '1px solid #bbf7d0'; }
    else { toast.style.background = '#eff6ff'; toast.style.color = '#1d4ed8'; toast.style.border = '1px solid #bfdbfe'; }
    toast.innerHTML = type === 'error' ? '❌ ' : type === 'success' ? '✅ ' : 'ℹ️ ';
    toast.innerHTML += msg;
    document.body.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, 3000);
}

// 通关弹窗
function showPopup(msg) {
    let popup = document.createElement('div');
    popup.style.cssText = 'position:fixed;left:50%;top:30%;transform:translate(-50%,-50%);background:rgba(255,255,255,0.98);padding:36px 40px 28px;border-radius:22px;box-shadow:0 12px 40px 0 rgba(31,38,135,0.18);z-index:9999;display:flex;flex-direction:column;align-items:center;gap:16px;';
    let text = document.createElement('div');
    text.textContent = msg;
    text.style.cssText = 'background:linear-gradient(90deg,#3b82f6 10%,#a21caf 90%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;font-weight:bold;font-size:2.2rem;text-align:center;';
    popup.appendChild(text);

    // 按钮行
    let btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:12px;margin-top:8px;';

    let stayBtn = document.createElement('button');
    stayBtn.textContent = '🏠 回到房间';
    stayBtn.className = 'btn';
    stayBtn.onclick = function() { popup.remove(); };

    let leaveBtn = document.createElement('button');
    leaveBtn.textContent = '🚪 退出房间';
    leaveBtn.className = 'btn btn-danger';
    leaveBtn.onclick = function() {
        popup.remove();
        if (typeof leaveRoom === 'function') leaveRoom();
    };

    btnRow.appendChild(stayBtn);
    btnRow.appendChild(leaveBtn);
    popup.appendChild(btnRow);

    // 关闭按钮
    let closeBtn = document.createElement('span');
    closeBtn.textContent = '×';
    closeBtn.style.cssText = 'position:absolute;top:12px;right:24px;cursor:pointer;font-size:2rem;color:#a21caf;font-weight:bold;';
    closeBtn.onclick = function() { popup.remove(); };
    popup.appendChild(closeBtn);
    document.body.appendChild(popup);
}

// 发送AI消息时按钮转圈圈
let sendBtnOriginal = sendBtn.innerHTML;
async function sendAIMessage(content) {
    sendBtn.disabled = true;
    sendBtn.innerHTML = '<span class="spinner" style="display:inline-block;width:22px;height:22px;border:3px solid #3b82f6;border-top:3px solid #fff;border-radius:50%;animation:spin 1s linear infinite;vertical-align:middle;"></span>';
    let msg_id = null;
    try {
        const res = await fetch('/api/send_message', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({code: roomCode, nickname, content})
        });
        const data = await res.json();
        if (data.msg_id) {
            msg_id = data.msg_id;
        } else if (data.reply) {
            // 兼容老接口
            await pollMessages();
            if (data.popup === '恭喜过关') showPopup('恭喜过关');
            sendBtn.disabled = false;
            sendBtn.innerHTML = sendBtnOriginal;
            return;
        } else {
            alert(data.error || 'AI消息发送失败');
            sendBtn.disabled = false;
            sendBtn.innerHTML = sendBtnOriginal;
            return;
        }
    } catch (e) {
        alert('AI消息发送失败');
        sendBtn.disabled = false;
        sendBtn.innerHTML = sendBtnOriginal;
        return;
    }
    // 轮询AI回复
    let start = Date.now();
    let gotReply = false;
    while (!gotReply && Date.now() - start < 30000) {
        await new Promise(r => setTimeout(r, 800));
        try {
            const res2 = await fetch('/api/get_ai_reply', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({msg_id})
            });
            const data2 = await res2.json();
            if (data2.status === 'pending') continue;
            if (data2.reply) {
                await pollMessages();
                if (data2.popup === '恭喜过关') showPopup('恭喜过关');
                gotReply = true;
                break;
            } else if (data2.error) {
                alert(data2.error);
                break;
            }
        } catch (e) {
            alert('AI回复获取失败');
            break;
        }
    }
    if (!gotReply) {
        alert('AI回复超时，请重试');
    }
    sendBtn.disabled = false;
    sendBtn.innerHTML = sendBtnOriginal;
}
// 加入转圈动画样式
const style = document.createElement('style');
style.innerHTML = `@keyframes spin { 0% { transform: rotate(0deg);} 100% {transform: rotate(360deg);} }`;
document.head.appendChild(style);

// 【凯喵推子 / 全AI修改】API 配置管理 UI（数据函数已移到文件上方）
// 显示 API 配置管理弹窗（挂载到 window 使其可从 HTML onclick 调用）
window.showApiManager = function() {
    let modal = document.getElementById('api-manager-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'api-manager-modal';
        modal.style = 'display:none;position:fixed;left:0;top:0;width:100vw;height:100vh;background:rgba(0,0,0,0.18);z-index:1000;align-items:center;justify-content:center;';
        modal.innerHTML = `
        <div style="background:#fff;padding:28px 24px;border-radius:16px;box-shadow:0 8px 32px 0 rgba(31,38,135,0.15);max-width:480px;width:90vw;max-height:80vh;overflow-y:auto;">
            <h3 style="color:#059669;margin-bottom:6px;">API 配置管理</h3>
            <p style="font-size:13px;color:#64748b;margin-bottom:16px;">配置保存在浏览器本地，多配置时按排序顺序自动故障转移</p>
            <div id="api-profile-list"></div>
            <div style="border-top:1px solid #e5e7eb;padding-top:16px;margin-top:12px;">
                <h4 style="margin:0 0 10px 0;font-size:14px;">添加配置</h4>
                <div class="form-group">
                    <label>配置名称</label>
                    <input type="text" id="api-new-name" placeholder="如：主力-硅基流动">
                </div>
                <div class="form-group">
                    <label>Base URL</label>
                    <input type="text" id="api-new-url" placeholder="https://api.openai.com/v1">
                </div>
                <div class="form-group">
                    <label>API Key</label>
                    <input type="password" id="api-new-key" placeholder="sk-...">
                </div>
                <div class="form-group">
                    <label>模型</label>
                    <input type="text" id="api-new-model" placeholder="gpt-4o-mini">
                </div>
                <button class="btn" id="api-add-btn" style="width:100%;justify-content:center;">保存配置</button>
                <div id="api-add-error" style="color:#ef4444;margin-top:8px;font-size:13px;display:none;"></div>
            </div>
            <button class="btn btn-secondary" onclick="document.getElementById('api-manager-modal').style.display='none'" style="width:100%;justify-content:center;margin-top:12px;">关闭</button>
        </div>`;
        document.body.appendChild(modal);

        // 加载服务端默认配置并预填表单
        fetch('/api/get_options').then(function(r){ return r.json(); }).then(function(data){
            var opt = (data.options || {});
            var urlEl = document.getElementById('api-new-url');
            var keyEl = document.getElementById('api-new-key');
            var modelEl = document.getElementById('api-new-model');
            var nameEl = document.getElementById('api-new-name');
            if (opt.base_urls && opt.base_urls[0] && !urlEl.value) urlEl.value = opt.base_urls[0];
            if (opt.api_keys && opt.api_keys[0] && !keyEl.value) keyEl.value = opt.api_keys[0];
            if (opt.models && opt.models[0] && !modelEl.value) modelEl.value = opt.models[0];
            if (!nameEl.value) nameEl.value = '服务器默认配置';
        }).catch(function(){});

        document.getElementById('api-add-btn').onclick = function() {
            const name = document.getElementById('api-new-name').value.trim();
            const base_url = document.getElementById('api-new-url').value.trim();
            const api_key = document.getElementById('api-new-key').value.trim();
            const model = document.getElementById('api-new-model').value.trim();
            if (!name || !base_url || !api_key || !model) {
                const err = document.getElementById('api-add-error');
                err.textContent = '请填写完整信息';
                err.style.display = 'block';
                return;
            }
            addApiProfile({name, base_url, api_key, model});
            document.getElementById('api-new-name').value = '';
            document.getElementById('api-new-url').value = '';
            document.getElementById('api-new-key').value = '';
            document.getElementById('api-new-model').value = '';
            document.getElementById('api-add-error').style.display = 'none';
            renderApiProfileList();
        };
    }
    renderApiProfileList();
    modal.style.display = 'flex';
}

function renderApiProfileList() {
    const container = document.getElementById('api-profile-list');
    if (!container) return;
    const profiles = getApiProfiles();
    if (profiles.length === 0) {
        container.innerHTML = '<div style="text-align:center;padding:20px;color:#94a3b8;">还没有API配置，请在下方添加</div>';
        return;
    }
    container.innerHTML = profiles.map((p, idx) => `
        <div style="background:#f8fafc;border-radius:8px;padding:10px 12px;margin-bottom:8px;border:1px solid #e5e7eb;">
            <div style="display:flex;justify-content:space-between;align-items:center;">
                <div style="font-weight:600;font-size:14px;">${escapeHtml(p.name)} ${idx === 0 ? '<span style="background:#059669;color:#fff;font-size:11px;padding:2px 6px;border-radius:4px;">主</span>' : ''}</div>
                <div style="display:flex;gap:4px;align-items:center;">
                    ${idx > 0 ? '<button class="btn btn-secondary" style="padding:2px 6px;font-size:11px;" onclick="moveApiProfile(' + idx + ',' + (idx-1) + ')">▲</button>' : ''}
                    ${idx < profiles.length - 1 ? '<button class="btn btn-secondary" style="padding:2px 6px;font-size:11px;" onclick="moveApiProfile(' + idx + ',' + (idx+1) + ')">▼</button>' : ''}
                    <button class="btn" style="padding:2px 8px;font-size:12px;" onclick="showApiEdit('${p.id}')">编辑</button>
                    <button class="btn btn-danger" style="padding:2px 8px;font-size:12px;" onclick="deleteApiProfile('${p.id}');renderApiProfileList();">删除</button>
                </div>
            </div>
            <div style="font-size:12px;color:#64748b;margin-top:4px;">${escapeHtml(p.model)}</div>
            <div style="font-size:11px;color:#94a3b8;">${escapeHtml(p.base_url)}</div>
        </div>
    `).join('');
}

// 编辑 API 配置（简化：弹窗提示编辑）
window.showApiEdit = function(id) {
    const profiles = getApiProfiles();
    const p = profiles.find(x => x.id === id);
    if (!p) return;
    const name = prompt('配置名称：', p.name);
    if (!name) return;
    const base_url = prompt('Base URL：', p.base_url);
    if (!base_url) return;
    const api_key = prompt('API Key：', p.api_key);
    if (!api_key) return;
    const model = prompt('模型：', p.model);
    if (!model) return;
    updateApiProfile(id, {name, base_url, api_key, model});
    renderApiProfileList();
};

// ==============================
// 【凯喵推子 / 全AI修改】改造创建房间流程
// 原：从服务端 /api/get_options 获取下拉选项
// 改：从 localStorage 读取 API 配置列表，复选框选择后传 api_profiles 数组
// 向后兼容：未配置时仍走旧逻辑
// ==============================
// 创建房间：从 localStorage 读取所有 API 配置，全部传给后端用于故障转移
// 用户需先在首页「API 配置」中添加配置
createBtn.onclick = async function() {
    const nick = document.getElementById('create-nickname').value.trim();
    const allProfiles = getApiProfiles();
    // 将所有本地配置转为后端需要的格式
    const profiles = allProfiles.map(p => ({base_url: p.base_url, api_key: p.api_key, model: p.model}));
    if (!nick || profiles.length === 0) {
        document.getElementById('create-error').textContent = '请先在「API 配置」中添加 API 配置并填写昵称';
        return;
    }
    createBtn.disabled = true;
    document.getElementById('create-error').textContent = '';
    try {
        const res = await fetch('/api/create_room', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({nickname: nick, api_profiles: profiles})
        });
        const data = await res.json();
        if (data.code) {
            roomCode = data.code;
            nickname = nick;
            isOwner = true;
            enterChat();
        } else {
            document.getElementById('create-error').textContent = data.error || '创建失败';
        }
    } catch (e) {
        document.getElementById('create-error').textContent = '网络错误';
    }
    createBtn.disabled = false;
};

// 初始化：检查用户是否已配置 API
(function checkApiConfig(){
    const profiles = getApiProfiles();
    if (profiles.length === 0) {
        const err = document.getElementById('create-error');
        if (err) err.textContent = '提示：请先点击首页「API 配置」按钮添加 API 配置';
    }
})();

// ==============================
// 【凯喵推子 / 全AI修改】问题库面板
// 显示房间内所有已问问题及其 AI 回答
// 从 /api/get_question_bank 获取数据
// ==============================
function showQuestionBank() {
    let modal = document.getElementById('question-bank-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'question-bank-modal';
        modal.style = 'display:none;position:fixed;left:0;top:0;width:100vw;height:100vh;background:rgba(0,0,0,0.18);z-index:1000;align-items:center;justify-content:center;';
        modal.innerHTML = `
        <div style="background:#fff;padding:28px 24px;border-radius:16px;box-shadow:0 8px 32px 0 rgba(31,38,135,0.15);max-width:560px;width:90vw;max-height:70vh;overflow-y:auto;">
            <h3 style="color:#059669;margin-bottom:6px;">问题库</h3>
            <p style="font-size:13px;color:#64748b;margin-bottom:16px;">所有已问问题列表。相似问题≥80%时会自动复用答案，减少AI消耗。</p>
            <div id="question-bank-list" style="text-align:center;padding:20px;color:#94a3b8;">加载中...</div>
            <button class="btn btn-secondary" onclick="document.getElementById('question-bank-modal').style.display='none'" style="width:100%;justify-content:center;margin-top:12px;">关闭</button>
        </div>`;
        document.body.appendChild(modal);
    }
    modal.style.display = 'flex';
    // 加载数据
    fetch('/api/get_question_bank', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({code: roomCode})
    }).then(r => r.json()).then(data => {
        const list = document.getElementById('question-bank-list');
        const questions = data.questions || [];
        if (questions.length === 0) {
            list.innerHTML = '<div style="color:#94a3b8;padding:20px;">暂无问题，开始游戏吧！</div>';
            return;
        }
        list.innerHTML = questions.map(q => `
            <div style="background:#f8fafc;border-radius:8px;padding:10px 12px;margin-bottom:8px;border:1px solid #e5e7eb;text-align:left;">
                <div style="font-size:13px;font-weight:600;color:#1e293b;">❓ ${escapeHtml(q.question)}</div>
                <div style="font-size:13px;color:#059669;margin-top:4px;">✅ ${escapeHtml(q.answer)}</div>
                <div style="font-size:11px;color:#94a3b8;margin-top:4px;">提问者：${escapeHtml(q.asked_by)}</div>
            </div>
        `).join('');
    }).catch(() => {
        document.getElementById('question-bank-list').innerHTML = '<div style="color:#ef4444;">加载失败</div>';
    });
}

// ==============================
// 【凯喵推子 / 全AI修改】AI 消息发送 — 支持问题库缓存命中
// 当后端直接返回 reply（from_cache=true）时:
//   1. 不走轮询，直接显示消息
//   2. 在聊天框顶部显示缓存命中提示
// 当后端返回 msg_id 时: 走原轮询逻辑
// ==============================
const originalSendAIMessage = sendAIMessage;
sendAIMessage = async function(content, force_ai = false) {
    sendBtn.disabled = true;
    sendBtn.innerHTML = '<span class="spinner" style="display:inline-block;width:22px;height:22px;border:3px solid #3b82f6;border-top:3px solid #fff;border-radius:50%;animation:spin 1s linear infinite;vertical-align:middle;"></span>';

    // 清除旧的坚持按钮
    const oldInsist = document.getElementById('insist-ai-btn');
    if (oldInsist) oldInsist.remove();

    let msg_id = null;
    try {
        const res = await fetch('/api/send_message', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({code: roomCode, nickname, content, force_ai})
        });
        const data = await res.json();
        if (data.msg_id) {
            msg_id = data.msg_id;
        } else if (data.reply) {
            await pollMessages();
            if (data.from_cache) {
                // ---- 问题库命中：显示坚持按钮（标签由 renderMessages 自动添加） ----
                const inputArea = document.querySelector('.chat-input-area');
                if (inputArea && !document.getElementById('insist-ai-btn')) {
                    const insistDiv = document.createElement('div');
                    insistDiv.id = 'insist-ai-btn';
                    insistDiv.style = 'padding:6px 12px;background:#fffbeb;border-radius:8px;margin-bottom:6px;display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:13px;';
                    const insistBtn = document.createElement('button');
                    insistBtn.className = 'btn';
                    insistBtn.style = 'padding:4px 12px;font-size:12px;white-space:nowrap;';
                    insistBtn.textContent = '🤖 坚持请求AI';
                    const originalContent = content; // 闭包捕获
                    insistBtn.onclick = function() {
                        insistDiv.remove();
                        sendAIMessage(originalContent, true);
                    };
                    insistDiv.innerHTML = `<span>💡 已匹配问题库（相似度${Math.round(data.matched_similarity*100)}%）</span>`;
                    insistDiv.appendChild(insistBtn);
                    inputArea.parentElement.insertBefore(insistDiv, inputArea);
                }
            }
            if (data.popup === '恭喜过关') showPopup('恭喜过关');
            sendBtn.disabled = false;
            sendBtn.innerHTML = sendBtnOriginal;
            return;
        } else {
            alert(data.error || 'AI消息发送失败');
            sendBtn.disabled = false;
            sendBtn.innerHTML = sendBtnOriginal;
            return;
        }
    } catch (e) {
        alert('AI消息发送失败');
        sendBtn.disabled = false;
        sendBtn.innerHTML = sendBtnOriginal;
        return;
    }
    // 轮询AI回复（非缓存路径）
    let start = Date.now();
    let gotReply = false;
    while (!gotReply && Date.now() - start < 30000) {
        await new Promise(r => setTimeout(r, 800));
        try {
            const res2 = await fetch('/api/get_ai_reply', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({msg_id})
            });
            const data2 = await res2.json();
            if (data2.status === 'pending') continue;
            if (data2.reply) {
                await pollMessages();
                if (data2.popup === '恭喜过关') showPopup('恭喜过关');
                gotReply = true;
                break;
            } else if (data2.error) {
                alert(data2.error);
                break;
            }
        } catch (e) {
            alert('AI回复获取失败');
            break;
        }
    }
    if (!gotReply) {
        alert('AI回复超时，请重试');
    }
    sendBtn.disabled = false;
    sendBtn.innerHTML = sendBtnOriginal;
};

// ==============================
// 【凯喵推子 / 全AI修改】AI 生成故事弹窗（房间内）
// 三阶段交互:
//   阶段1 - 输入: 故事主题(可选) + 开始生成
//   阶段2 - 结果: 展示汤面/胜利条件 + 使用/继续调整
//   阶段3 - 微调: 多轮对话修改故事 + 应用更改
// ==============================
function showAIGenerationModal() {
    let modal = document.getElementById('ai-gen-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'ai-gen-modal';
        modal.style = 'display:none;position:fixed;left:0;top:0;width:100vw;height:100vh;background:rgba(0,0,0,0.18);z-index:1000;align-items:center;justify-content:center;';
        modal.innerHTML = [
            '<div style="background:#fff;padding:28px 24px;border-radius:16px;box-shadow:0 8px 32px 0 rgba(31,38,135,0.15);max-width:520px;width:90vw;max-height:80vh;overflow-y:auto;">',
            '  <h3 style="color:#059669;margin-top:0;">🎲 AI 生成海龟汤</h3>',
            '  <p style="font-size:13px;color:#64748b;margin-bottom:16px;">输入主题让AI生成，或直接点「随机生成」</p>',
            '  <div id="ai-gen-input-area">',
            '    <div class="form-group">',
            '      <label>故事主题（可选）</label>',
            '      <input type="text" id="ai-gen-prompt" placeholder="如：校园悬疑、都市传说..." style="width:100%;">',
            '    </div>',
            '    <div style="display:flex;gap:8px;">',
            '      <button class="btn" id="ai-gen-start-btn" style="flex:1;justify-content:center;">✨ 开始生成</button>',
            '      <button class="btn btn-secondary" id="ai-gen-random-btn" style="flex:1;justify-content:center;">🎲 随机生成</button>',
            '    </div>',
            '    <div id="ai-gen-loading" style="display:none;text-align:center;padding:16px;">',
            '      <span class="spinner" style="display:inline-block;width:24px;height:24px;border:3px solid #e5e7eb;border-top:3px solid #059669;border-radius:50%;animation:spin 1s linear infinite;"></span>',
            '      <div style="margin-top:8px;color:#64748b;">AI正在创作中...</div>',
            '    </div>',
            '    <div id="ai-gen-error" style="display:none;color:#ef4444;margin-top:10px;font-size:13px;"></div>',
            '    <button class="btn btn-secondary" onclick="closeAIGenModal()" style="width:100%;justify-content:center;margin-top:12px;">取消</button>',
            '  </div>',
            '  <div id="ai-gen-result" style="display:none;">',
            '    <div id="ai-gen-result-content"></div>',
            '    <div style="display:flex;gap:8px;margin-top:16px;">',
            '      <button class="btn" onclick="useGeneratedStory()" style="flex:1;justify-content:center;">使用此故事</button>',
            '      <button class="btn btn-secondary" onclick="closeAIGenModal()" style="flex:1;justify-content:center;">关闭</button>',
            '    </div>',
            '  </div>',
        '</div>'].join('\n');
        document.body.appendChild(modal);
        document.getElementById('ai-gen-start-btn').onclick = function() { doAiGen(false); };
        document.getElementById('ai-gen-random-btn').onclick = function() { doAiGen(true); };
    }
    document.getElementById('ai-gen-input-area').style.display = 'block';
    document.getElementById('ai-gen-result').style.display = 'none';
    document.getElementById('ai-gen-loading').style.display = 'none';
    document.getElementById('ai-gen-error').style.display = 'none';
    document.getElementById('ai-gen-prompt').value = '';
    modal.style.display = 'flex';
}
window.closeAIGenModal = function() {
    var m = document.getElementById('ai-gen-modal');
    if (m) m.style.display = 'none';
};
async function doAiGen(randomMode) {
    var prompt = '';
    if (!randomMode) prompt = document.getElementById('ai-gen-prompt').value.trim();
    var btn = document.getElementById('ai-gen-start-btn');
    var loading = document.getElementById('ai-gen-loading');
    var error = document.getElementById('ai-gen-error');
    btn.disabled = true;
    loading.style.display = 'block';
    error.style.display = 'none';
    try {
        var res = await fetch('/api/ai_generate_story', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({code: roomCode, nickname: nickname, prompt: prompt || undefined})
        });
        var data = await res.json();
        loading.style.display = 'none';
        if (data.success && data.story) {
            window._generatedStory = data.story;
            document.getElementById('ai-gen-input-area').style.display = 'none';
            document.getElementById('ai-gen-result').style.display = 'block';
            var s = data.story;
            document.getElementById('ai-gen-result-content').innerHTML =
                '<div style="background:#f0fdf4;border-radius:8px;padding:12px;margin-bottom:10px;">' +
                '  <div style="font-weight:600;color:#059669;margin-bottom:4px;">📖 汤面</div>' +
                '  <div style="white-space:pre-wrap;">' + escapeHtml(s.surface) + '</div></div>' +
                '<div style="background:#fef3c7;border-radius:8px;padding:12px;margin-bottom:10px;">' +
                '  <div style="font-weight:600;color:#d97706;margin-bottom:4px;">🏆 胜利条件</div>' +
                '  <div>' + escapeHtml(s.victory_condition || '未设置') + '</div></div>' +
                '<div style="background:#f1f5f9;border-radius:8px;padding:12px;font-size:12px;color:#64748b;">' +
                '  <div style="font-weight:600;margin-bottom:4px;">ℹ️ 补充说明</div>' +
                '  <div>' + escapeHtml(s.additional || '无') + '</div></div>';
        } else {
            error.textContent = data.error || '生成失败，请重试';
            error.style.display = 'block';
        }
    } catch (e) {
        loading.style.display = 'none';
        error.textContent = '网络错误，请重试';
        error.style.display = 'block';
    }
    btn.disabled = false;
}
window.useGeneratedStory = function() {
    fetchCurrentStory();
    closeAIGenModal();
    showToast('故事已加载到房间！', 'success');
};

// ==============================
// 【凯喵推子 / 全AI修改】故事微调对话界面
// 与后端 /api/ai_refine_story 交互，实现多轮对话修改故事
// 每次 AI 回复后更新 window._generatedStory 并展示更新后的故事
// ==============================
function showAIRefinement() {
    document.getElementById('ai-gen-result').style.display = 'none';
    document.getElementById('ai-gen-refine').style.display = 'block';
    const story = window._generatedStory;
    const msgDiv = document.getElementById('ai-refine-messages');
    msgDiv.innerHTML = `
        <div style="margin-bottom:8px;"><strong>📖 当前故事：</strong></div>
        <div style="background:white;padding:8px;border-radius:6px;margin-bottom:8px;font-size:13px;">
            <div style="color:#059669;font-weight:600;">汤面</div>
            <div style="white-space:pre-wrap;">${escapeHtml(story ? story.surface : '')}</div>
        </div>
        <div style="background:white;padding:8px;border-radius:6px;margin-bottom:8px;font-size:13px;">
            <div style="color:#d97706;font-weight:600;">胜利条件</div>
            <div>${escapeHtml(story ? story.victory_condition : '')}</div>
        </div>
    `;
}

async function sendRefinement() {
    const input = document.getElementById('ai-refine-input');
    const message = input.value.trim();
    if (!message) return;

    const msgDiv = document.getElementById('ai-refine-messages');
    const loading = document.getElementById('ai-refine-loading');
    const error = document.getElementById('ai-refine-error');

    msgDiv.innerHTML += `<div style="text-align:right;margin:4px 0;color:#3b82f6;font-size:14px;">🧑 ${escapeHtml(message)}</div>`;
    input.value = '';
    loading.style.display = 'block';
    error.style.display = 'none';

    try {
        const res = await fetch('/api/ai_refine_story', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({code: roomCode, nickname, message})
        });
        const data = await res.json();
        loading.style.display = 'none';
        if (data.story) {
            window._generatedStory = data.story;
            msgDiv.innerHTML += `<div style="margin:4px 0;background:white;padding:8px;border-radius:6px;font-size:14px;">🤖 ${escapeHtml(data.reply || '已更新')}</div>`;
            msgDiv.innerHTML += `
                <div style="background:#f0fdf4;padding:8px;border-radius:6px;margin:6px 0;font-size:13px;">
                    <strong>📖 更新后的故事：</strong><br>
                    汤面：${escapeHtml(data.story.surface)}<br>
                    胜利条件：${escapeHtml(data.story.victory_condition)}
                </div>
            `;
        } else {
            error.textContent = data.error || '调整失败';
            error.style.display = 'block';
        }
    } catch (e) {
        loading.style.display = 'none';
        error.textContent = '网络错误';
        error.style.display = 'block';
    }
    msgDiv.scrollTop = msgDiv.scrollHeight;
}

function applyRefinedStory() {
    fetchCurrentStory();
    closeAIGenModal();
    alert('故事已更新！');
}

// ==============================
// 【凯喵推子 / 全AI修改】重写 enterChat：在 setupUploadBtn 后追加 AI 生成和问题库按钮
// ==============================
// 在 enterChat 中 setupUploadBtn 后已追加，无需额外监听

// 在 setupUploadBtn 中已经通过 innerHTML 覆盖了 story-ops，
// 所以我们需要在 setupUploadBtn 执行后额外添加按钮。
// 改为在 enterChat 中 setupUploadBtn 后追加
const origEnterChat = enterChat;
enterChat = function(roomInfo) {
    showPage('chat');
    document.getElementById('invite-code').textContent = roomCode;
    document.getElementById('room-info-text').textContent = roomInfo ? `房主: ${roomInfo.owner} | 模型: ${roomInfo.model}` : '';
    window.roomOwner = roomInfo ? roomInfo.owner : '';
    document.getElementById('delete-room-btn').style.display = isOwner ? '' : 'none';
    document.getElementById('user-input').value = '';
    document.getElementById('chat-box').innerHTML = '';
    document.getElementById('story-ops').style.display = isOwner ? '' : 'none';
    setupUploadBtn();
    // 追加 AI 生成和问题库按钮
    const storyOps = document.getElementById('story-ops');
    if (storyOps && isOwner) {
        const extraDiv = document.createElement('div');
        extraDiv.style = 'margin-top:8px;display:flex;flex-direction:column;gap:6px;';
        const aiBtn = document.createElement('button');
        aiBtn.className = 'btn';
        aiBtn.style.cssText = 'width:100%;justify-content:center;padding:6px 12px;font-size:14px;';
        aiBtn.innerHTML = '<span class="iconify" data-icon="lucide:wand-2"></span> AI生成故事';
        aiBtn.onclick = function() { showAIGenerationModal(); };
        extraDiv.appendChild(aiBtn);
        storyOps.appendChild(extraDiv);
    }
    // 在所有房间成员右侧添加问题库按钮
    const sidebar = document.querySelector('.user-list-panel');
    if (sidebar) {
        let qbBtn = document.getElementById('question-bank-btn');
        if (!qbBtn) {
            qbBtn = document.createElement('button');
            qbBtn.id = 'question-bank-btn';
            qbBtn.className = 'btn btn-secondary';
            qbBtn.style = 'width:100%;justify-content:center;padding:6px 12px;font-size:13px;margin-top:8px;';
            qbBtn.innerHTML = '<span class="iconify" data-icon="lucide:database"></span> 问题库';
            qbBtn.onclick = showQuestionBank;
            sidebar.appendChild(qbBtn);
        }
    }
    fetchCurrentStory();
    startPolling();
    saveSession();
    pollChatMessages();
    pollOnlineUsers();
    if (chatPolling) clearInterval(chatPolling);
    if (onlinePolling) clearInterval(onlinePolling);
    chatPolling = setInterval(pollChatMessages, 2000);
    onlinePolling = setInterval(pollOnlineUsers, 5000);
    startHeartbeat();
    window._popupPassedFlag = false;
};

});