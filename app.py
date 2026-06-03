# =============================================================================
# AI海龟汤聊天室 - Flask 后端
# 原作者: mumuhaha (https://github.com/mumuhaha487/Turtle_Soup)
# =============================================================================
# 【凯喵推子 / 全AI修改】以下功能由 Claude Code 生成:
#   - API 故障转移 (call_llm_with_failover)
#   - 智能问题库 (问题相似度匹配、缓存复用)
#   - AI 生成故事 (/api/ai_generate_story)
#   - 多轮微调故事 (/api/ai_refine_story)
#   - 故事广场 AI 生成 (/api/ai_generate_plaza)
#   - 创建房间支持多配置 (api_profiles)
#   详细说明见 README.md 社区修改版本章节
# =============================================================================

from flask import Flask, render_template, request, jsonify, session, redirect
from openai import OpenAI
from flask_cors import CORS
import random, string, threading, json, time
import os
from concurrent.futures import ThreadPoolExecutor, as_completed
import uuid
import datetime
# 【凯喵推子】新增 difflib 用于问题库文本相似度匹配
from difflib import SequenceMatcher

app = Flask(__name__)
CORS(app)
app.secret_key = 'haiguitang-secret-key'  # 用于session

# 加载config.json
with open('config.json', 'r', encoding='utf-8') as f:
    config = json.load(f)
PRESET = config.get('preset', None)
ADMIN_USERNAME = config.get('admin', {}).get('username', 'admin')
ADMIN_PASSWORD = config.get('admin', {}).get('password', 'admin123')
STORY_COUNTER = config.get('story_counter', 1)
OPTIONS = config.get('options', {
    'models': ['gpt-5-chat-2025-08-07', 'o3-mini-2025-01-31'],
    'base_urls': ['http://api.0ha.top/v1'],
    'api_keys': []
})
ANNOUNCEMENTS = config.get('announcements', '')

# 保存config.json计数
def save_story_counter(counter):
    with open('config.json', 'r', encoding='utf-8') as f:
        config = json.load(f)
    config['story_counter'] = counter
    with open('config.json', 'w', encoding='utf-8') as f:
        json.dump(config, f, ensure_ascii=False, indent=2)

def save_options(options):
    with open('config.json', 'r', encoding='utf-8') as f:
        config = json.load(f)
    config['options'] = options
    with open('config.json', 'w', encoding='utf-8') as f:
        json.dump(config, f, ensure_ascii=False, indent=2)

def save_announcements(content):
    with open('config.json', 'r', encoding='utf-8') as f:
        config = json.load(f)
    config['announcements'] = content
    with open('config.json', 'w', encoding='utf-8') as f:
        json.dump(config, f, ensure_ascii=False, indent=2)

CUSTOM_STORY_RESTORE_GUIDE = (
    "【重要规则补充】\n"
    "1. 当玩家的提问以‘开始故事还原：’开头时，只能回复：故事还原错误、故事还原正确、故事还原大致正确三种标签，回复内容只能是这三个标签之一，不能有其他内容、提示、解释或标点，用户会自行揭晓谜底或继续提问。\n"
    "- 绝对不能给出任何提示、解释或标点。\n"
    "2. 当玩家回复‘整理线索’时，请你整理之前所有AI回答中有用的线索和不重要的线索：\n"
    "- 只总结AI已经明确回答过的有用线索和不重要的线索，绝对不要展开联想，绝对不要根据汤底推测未被问到的内容。\n"
    "- ‘是’或‘不是’的问题，如果无法确定线索可输出‘不确定’。\n"
    "- ‘不重要’的信息要单独整理和汇报。\n"
    "- 整理时要简明扼要，避免剧透和过度推理。\n"
    "其余时间请严格按照海龟汤规则进行推理问答。\n"
    "3. 回答时需判断问题的重要性：如果问题对解开谜底很关键，回答'是（关键提问）'或'否（关键提问）'；"
    "如果是一般性问题，正常回答'是'、'不是'或'不重要'。"
)

# 故事广场相关目录
STORY_UPLOAD_DIR = 'upload/json/norelease'
STORY_RELEASE_DIR = 'upload/json/release'
os.makedirs(STORY_UPLOAD_DIR, exist_ok=True)
os.makedirs(STORY_RELEASE_DIR, exist_ok=True)

# 【凯喵推子】AI 生成提示词预设目录
PRESETS_DIR = 'presets'
os.makedirs(PRESETS_DIR, exist_ok=True)
# 创建默认预设（如果不存在）
DEFAULT_PRESET_PATH = os.path.join(PRESETS_DIR, 'default.json')
if not os.path.exists(DEFAULT_PRESET_PATH):
    default_preset = [
        {
            "role": "system",
            "content": "你是一个海龟汤（Turtle Soup）谜题创作大师。海龟汤是一种推理游戏，玩家通过提问来还原故事真相。请根据用户的要求创作海龟汤谜题。"
        },
        {
            "role": "system",
            "content": "请严格按照以下JSON格式输出，不要包含除了JSON以外的任何内容：\n{\n  \"surface\": \"汤面（谜题表面描述，给玩家看的部分，要有悬念和吸引力）\",\n  \"answer\": \"汤底（完整的真相故事，只有出题者知道，要逻辑合理）\",\n  \"additional\": \"给AI主持人的补充说明（关键细节、规则等）\",\n  \"victory_condition\": \"胜利条件（玩家需要猜出的关键点）\"\n}\n\n要求：\n1. 故事要有创意\n2. 汤底要完整\n3. 胜利条件要清晰"
        }
    ]
    with open(DEFAULT_PRESET_PATH, 'w', encoding='utf-8') as f:
        json.dump({'id': 'default', 'name': '默认预设', 'messages': default_preset}, f, ensure_ascii=False, indent=2)

# 内存房间存储
rooms = {}
rooms_lock = threading.Lock()

# 全局线程池
ai_executor = ThreadPoolExecutor(max_workers=8)
# 存储AI异步任务结果
ai_tasks = {}

# 【凯喵推子 / 全AI修改】辅助函数 — 故障转移、问题库、AI 生成
# ============================================================

def call_llm_with_failover(profiles, messages, **kwargs):
    """按顺序尝试多个API配置，失败自动切换下一个，全部失败则抛出最后一个异常"""
    last_error = None
    for i, profile in enumerate(profiles):
        try:
            client = OpenAI(
                base_url=profile['base_url'],
                api_key=profile['api_key'],
                timeout=kwargs.get('timeout', 60)
            )
            completion = client.chat.completions.create(
                model=profile['model'],
                messages=messages,
                timeout=kwargs.get('timeout', 60)
            )
            return completion.choices[0].message.content, i
        except Exception as e:
            last_error = e
            continue
    raise last_error or Exception('所有API配置均不可用')

def calc_similarity(q1, q2):
    """计算两个问题的文本相似度 (0~1)"""
    if not q1 or not q2:
        return 0
    return SequenceMatcher(None, q1, q2).ratio()

def find_matching_question(question_bank, question, threshold=0.8):
    """在问题库中查找相似度≥threshold的问题，返回(匹配项, 相似度)或(None, 0)"""
    for item in question_bank:
        sim = calc_similarity(item['question'], question)
        if sim >= threshold:
            return item, sim
    return None, 0

def build_generation_prompt(user_prompt=''):
    """构建AI故事生成的系统prompt"""
    base = (
        "你是一个海龟汤（Turtle Soup）谜题创作大师。海龟汤是一种推理游戏，"
        "玩家通过提问来还原故事真相。\n\n"
        "请严格按照以下JSON格式输出一个海龟汤谜题，不要包含除了JSON以外的任何内容：\n"
        "{\n"
        '  "surface": "汤面（谜题表面描述，给玩家看的部分，要有悬念和吸引力，3-5句话）",\n'
        '  "answer": "汤底（完整的真相故事，只有出题者知道，要逻辑合理）",\n'
        '  "additional": "给AI主持人的补充说明（关键细节、规则等）",\n'
        '  "victory_condition": "胜利条件（玩家需要猜出的关键点）"\n'
        "}\n\n"
        "要求：\n"
        "1. 故事要有创意，风格不限（悬疑、惊悚、温馨、哲理均可）\n"
        "2. 汤底要完整，包含所有关键逻辑细节\n"
        "3. 胜利条件要清晰具体，便于AI判断玩家是否达成\n"
        "4. 输出必须是可以直接json.loads()解析的有效JSON"
    )
    if user_prompt:
        base += f"\n\n额外要求：{user_prompt}"
    return base

def build_refinement_prompt(story):
    """构建故事微调的系统prompt"""
    return (
        "你是海龟汤故事编辑助手。用户正在完善一个海龟汤谜题。当前故事如下：\n\n"
        f"汤面：{story.get('surface', '')}\n"
        f"汤底：{story.get('answer', '')}\n"
        f"补充说明：{story.get('additional', '')}\n"
        f"胜利条件：{story.get('victory_condition', '')}\n\n"
        "用户会提出修改要求，请根据要求修改故事。\n"
        "在回复时，先简要解释你做了哪些修改，然后另起一行以JSON格式输出完整的更新后的故事（包含所有字段）：\n"
        "{\n"
        '  "surface": "...",\n'
        '  "answer": "...",\n'
        '  "additional": "...",\n'
        '  "victory_condition": "..."\n'
        "}\n"
        "请确保JSON完整有效且是单次输出。"
    )

def extract_json_from_reply(text):
    """从AI回复文本中提取JSON对象"""
    import re
    json_match = re.search(r'\{[^{}]*\}', text, re.DOTALL)
    if json_match:
        try:
            return json.loads(json_match.group())
        except json.JSONDecodeError:
            pass
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None

def gen_code(length=6):
    return ''.join(random.choices(string.ascii_uppercase + string.digits, k=length))

@app.route('/')
def index():
    return render_template('index.html')

# 【凯喵推子 / 全AI修改】改造 create_room：支持多配置 api_profiles
# 新增 ai_gen_context（AI生成故事微调历史）、question_bank（问题库）
# 原单配置字段（base_url/api_key/model）保持向后兼容
@app.route('/api/create_room', methods=['POST'])
def create_room():
    """创建房间（支持多API配置故障转移）"""
    data = request.json
    nickname = data.get('nickname')
    # 优先使用多配置数组，其次兼容旧字段
    profiles = data.get('api_profiles', [])
    if profiles and len(profiles) > 0:
        base_url = profiles[0]['base_url']
        api_key = profiles[0]['api_key']
        model = profiles[0]['model']
    else:
        base_url = data.get('base_url')
        api_key = data.get('api_key')
        model = data.get('model')
        if base_url and api_key and model:
            profiles = [{'base_url': base_url, 'api_key': api_key, 'model': model}]
    if not (nickname and profiles and profiles[0]):
        return jsonify({'error': '请填写完整信息'}), 400
    code = gen_code()
    with rooms_lock:
        while code in rooms:
            code = gen_code()
        rooms[code] = {
            'owner': nickname,
            'api_profiles': profiles,
            'base_url': profiles[0]['base_url'],
            'api_key': profiles[0]['api_key'],
            'model': profiles[0]['model'],
            'messages': [],
            'ai_context': [],
            'ai_gen_context': [],
            'question_bank': [],
            'ai_busy': False,
            'members': {nickname: {'nickname': nickname}}
        }
    session['nickname'] = nickname
    session['room_code'] = code
    return jsonify({'code': code})

@app.route('/api/join_room', methods=['POST'])
def join_room():
    data = request.json
    nickname = data.get('nickname')
    code = data.get('code')
    if not (nickname and code):
        return jsonify({'error': '参数不完整'}), 400
    with rooms_lock:
        room = rooms.get(code)
        if not room:
            return jsonify({'error': '房间不存在'}), 404
        if nickname in room['members']:
            return jsonify({'error': '昵称已存在'}), 400
        room['members'][nickname] = {'nickname': nickname}
        # 新增：加入在线用户
        if 'online_users' not in room:
            room['online_users'] = {}
        room['online_users'][nickname] = time.time()
        # 新增：初始化无AI群聊消息
        if 'chat_messages' not in room:
            room['chat_messages'] = []
    session['nickname'] = nickname
    session['room_code'] = code
    return jsonify({'success': True, 'room': {'owner': room['owner'], 'model': room['model']}})

@app.route('/api/heartbeat', methods=['POST'])
def heartbeat():
    data = request.json
    code = data.get('code')
    nickname = data.get('nickname')
    if not (code and nickname):
        return jsonify({'error': '参数不完整'}), 400
    with rooms_lock:
        room = rooms.get(code)
        if not room or nickname not in room['members']:
            return jsonify({'error': '房间或用户不存在'}), 404
        if 'online_users' not in room:
            room['online_users'] = {}
        room['online_users'][nickname] = time.time()
    return jsonify({'success': True})

@app.route('/api/get_online_users', methods=['POST'])
def get_online_users():
    data = request.json
    code = data.get('code')
    if not code:
        return jsonify({'error': '参数不完整'}), 400
    now = time.time()
    with rooms_lock:
        room = rooms.get(code)
        if not room or 'online_users' not in room:
            return jsonify({'users': []})
        # 1分钟无心跳视为下线
        users = [u for u, t in room['online_users'].items() if now - t < 60]
    return jsonify({'users': users})

@app.route('/api/send_chat_message', methods=['POST'])
def send_chat_message():
    data = request.json
    code = data.get('code')
    nickname = data.get('nickname')
    content = data.get('content')
    if not (code and nickname and content):
        return jsonify({'error': '参数不完整'}), 400
    with rooms_lock:
        room = rooms.get(code)
        if not room or nickname not in room['members']:
            return jsonify({'error': '房间或用户不存在'}), 404
        if 'chat_messages' not in room:
            room['chat_messages'] = []
        room['chat_messages'].append({'nickname': nickname, 'content': content, 'time': int(time.time())})
        # 只保留最新100条
        if len(room['chat_messages']) > 100:
            room['chat_messages'] = room['chat_messages'][-100:]
    return jsonify({'success': True})

@app.route('/api/get_chat_messages', methods=['POST'])
def get_chat_messages():
    data = request.json
    code = data.get('code')
    if not code:
        return jsonify({'error': '参数不完整'}), 400
    with rooms_lock:
        room = rooms.get(code)
        if not room or 'chat_messages' not in room:
            return jsonify({'messages': []})
        return jsonify({'messages': room['chat_messages']})

# 【凯喵推子 / 全AI修改】改造 send_message：
# 1. 增加问题库匹配 check（相似度≥80% 直接复用缓存，不走API）
# 2. AI 调用改为 call_llm_with_failover 实现故障转移
# 3. 新增 force_ai 参数让用户可以强制请求AI回答
@app.route('/api/send_message', methods=['POST'])
def send_message():
    """
    发送 AI 消息（智能问题库 + 故障转移）
    - 先检查问题库是否有相似问题（≥80%），有则直接返回缓存答案
    - 无匹配则用 call_llm_with_failover 调用AI（自动故障转移）
    - Q&A 始终加入 ai_context 保持 AI 上下文感知
    """
    data = request.json
    code = data.get('code')
    nickname = data.get('nickname')
    content = data.get('content')
    force_ai = data.get('force_ai', False)  # 为true时跳过问题库匹配，强制请求AI
    if not (code and nickname and content):
        return jsonify({'error': '参数不完整'}), 400
    with rooms_lock:
        room = rooms.get(code)
        if not room:
            return jsonify({'error': '房间不存在'}), 404
        if nickname not in room['members']:
            return jsonify({'error': '未加入房间'}), 403
        # 串行提问：检查 AI 是否正忙
        if room.get('ai_busy'):
            return jsonify({'error': 'AI正在回答上一个问题，请稍等', 'busy': True}), 429
        room['ai_busy'] = True
        room['messages'].append({'role': 'user', 'content': content, 'nickname': nickname})
        # 构建问题库
        if 'question_bank' not in room:
            room['question_bank'] = []
        # 如果不是强制AI回答，先检查问题库
        if not force_ai:
            matched, similarity = find_matching_question(room['question_bank'], content)
            if matched:
                reply = matched['answer']
                # 仍将Q&A加入ai_context保持AI感知
                # 【凯喵推子】添加 from_cache 标记，前端据此显示「📚 问题库」标签
                room['messages'].append({'role': 'assistant', 'content': reply, 'nickname': 'AI', 'from_cache': True})
                if 'ai_context' not in room:
                    room['ai_context'] = []
                room['ai_context'].append({'role': 'user', 'content': f"{nickname}: {content}"})
                room['ai_context'].append({'role': 'assistant', 'content': reply})
                if len(room['ai_context']) > 40:
                    room['ai_context'] = room['ai_context'][-40:]
                room['ai_busy'] = False
                return jsonify({
                    'reply': reply,
                    'from_cache': True,
                    'matched_question': matched['question'],
                    'matched_similarity': similarity,
                    'msg_id': None,
                    'status': 'done'
                })
        # 需要调用AI
        profiles = room.get('api_profiles', [])
        if not profiles:
            profiles = [{'base_url': room.get('base_url'), 'api_key': room.get('api_key'), 'model': room.get('model')}]
        ai_context_copy = list(room.get('ai_context', []))
        question_bank_copy = list(room.get('question_bank', []))
    # 异步执行AI调用
    msg_id = str(uuid.uuid4())
    def ai_task():
        try:
            # 构建preset
            with rooms_lock:
                r = rooms.get(code)
                if r:
                    stories = r.get('stories')
                    current_story = r.get('current_story')
                else:
                    stories, current_story = None, None
            story_text = ''
            if stories and current_story is not None:
                story = stories[current_story]
                additional = story.get('additional', '')
                victory_condition = story.get('victory_condition', '')
                if PRESET and PRESET.strip():
                    preset = PRESET + '\n' + CUSTOM_STORY_RESTORE_GUIDE
                else:
                    preset = (f"你现在是海龟汤推理游戏的主持人。当前题目如下：\n\n"
                              f"汤面：{story.get('surface', '')}\n\n"
                              "游戏规则：出题者先给出不完整的'汤面'（题目），让猜题者提出各种可能性的问题，"
                              "而出题者回答时需先判断问题的重要性：如果问题对解开谜底很关键，应该回答'是（关键提问）'或'否（关键提问）'；"
                              "如果只是一般性问题且不关键，回答'是'、'不是'或'不重要'。"
                              "猜题者在有限的线索中推理出事件的始末，拼出故事的全貌，凑出一个'汤底'（答案）。"
                              "你只需根据规则回答问题，不要直接给出答案。"
                              "同时会给出胜利条件，由你来决定是否过关。\n\n"
                              f"补充说明（仅供AI参考）：{additional}\n\n"
                              f"胜利条件：{victory_condition}\n") + CUSTOM_STORY_RESTORE_GUIDE
            else:
                preset = ((PRESET + '\n' + CUSTOM_STORY_RESTORE_GUIDE)
                          if PRESET and PRESET.strip()
                          else "当前房间还没有上传题目，请房主上传海龟汤题目（json文件）。")
            messages = [{'role': 'system', 'content': preset}]
            messages.extend(ai_context_copy)
            messages.append({'role': 'user', 'content': f"{nickname}: {content}"})
            reply, used_idx = call_llm_with_failover(profiles, messages)
        except Exception as e:
            reply = f'[AI错误]{str(e)}'
            used_idx = -1
        with rooms_lock:
            r2 = rooms.get(code)
            if r2: r2['ai_busy'] = False
        popup = None
        with rooms_lock:
            room = rooms.get(code)
            if not room:
                return {'error': '房间不存在'}
            room['ai_busy'] = False
            room['messages'].append({'role': 'assistant', 'content': reply, 'nickname': 'AI'})
            if 'ai_context' not in room:
                room['ai_context'] = []
            room['ai_context'].append({'role': 'user', 'content': f"{nickname}: {content}"})
            room['ai_context'].append({'role': 'assistant', 'content': reply})
            if len(room['ai_context']) > 40:
                room['ai_context'] = room['ai_context'][-40:]
            # 加入问题库（先去重：删除相似度 ≥90% 的旧条目）
            if 'question_bank' not in room:
                room['question_bank'] = []
            room['question_bank'] = [q for q in room['question_bank']
                                      if calc_similarity(q['question'], content) < 0.9]
            room['question_bank'].append({
                'id': len(room['question_bank']) + 1,
                'question': content,
                'answer': reply,
                'asked_by': nickname,
                'timestamp': int(time.time())
            })
            if '故事还原正确' in reply or '故事还原大致正确' in reply:
                popup = '恭喜过关'
                room['passed'] = True
        return {'reply': reply, 'popup': popup, 'from_cache': False}
    future = ai_executor.submit(ai_task)
    ai_tasks[msg_id] = future
    return jsonify({'msg_id': msg_id, 'status': 'pending'})

@app.route('/api/get_ai_reply', methods=['POST'])
def get_ai_reply():
    data = request.json
    msg_id = data.get('msg_id')
    if not msg_id or msg_id not in ai_tasks:
        return jsonify({'error': '无效的消息ID'}), 400
    future = ai_tasks[msg_id]
    if future.done():
        result = future.result()
        del ai_tasks[msg_id]
        return jsonify(result)
    else:
        return jsonify({'status': 'pending'})

@app.route('/api/get_messages', methods=['POST'])
def get_messages():
    data = request.json
    code = data.get('code')
    if not code:
        return jsonify({'error': '参数不完整'}), 400
    with rooms_lock:
        room = rooms.get(code)
        if not room:
            return jsonify({'error': '房间不存在'}), 404
        return jsonify({'messages': room['messages'], 'passed': room.get('passed', False)})

@app.route('/api/delete_room', methods=['POST'])
def delete_room():
    data = request.json
    code = data.get('code')
    nickname = data.get('nickname')
    if not (code and nickname):
        return jsonify({'error': '参数不完整'}), 400
    with rooms_lock:
        room = rooms.get(code)
        if not room:
            return jsonify({'error': '房间不存在'}), 404
        if room['owner'] != nickname:
            return jsonify({'error': '只有房主可以删除房间'}), 403
        del rooms[code]
    return jsonify({'success': True})

# 保留单人对话接口
@app.route('/chat', methods=['POST'])
def chat():
    data = request.json
    base_url = data.get('base_url')
    api_key = data.get('api_key')
    model = data.get('model')
    messages = data.get('messages')
    if not (base_url and api_key and model and messages):
        return jsonify({'error': '参数不完整'}), 400
    try:
        client = OpenAI(base_url=base_url, api_key=api_key)
        completion = client.chat.completions.create(
            model=model,
            messages=messages
        )
        reply = completion.choices[0].message.content
        return jsonify({'reply': reply})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/upload_story', methods=['POST'])
def upload_story():
    code = request.form.get('code')
    nickname = request.form.get('nickname')
    if not (code and nickname):
        return jsonify({'error': '参数不完整'}), 400
    with rooms_lock:
        room = rooms.get(code)
        if not room:
            return jsonify({'error': '房间不存在'}), 404
        if room['owner'] != nickname:
            return jsonify({'error': '只有房主可以上传题目'}), 403
        if 'stories' not in room:
            room['stories'] = []
        files = request.files.getlist('file')
        for file in files:
            # 检查文件大小限制 (20MB = 20 * 1024 * 1024 bytes)
            file.seek(0, 2)  # 移动到文件末尾
            file_size = file.tell()  # 获取文件大小
            file.seek(0)  # 重置文件指针到开头
            if file_size > 20 * 1024 * 1024:  # 20MB
                return jsonify({'error': '文件大小不能超过20MB'}), 400
            try:
                story = json.load(file)
                if isinstance(story, list):
                    room['stories'].extend(story)
                else:
                    room['stories'].append(story)
            except Exception as e:
                return jsonify({'error': f'文件解析失败: {str(e)}'}), 400
        # 默认切换到最新上传的题目
        room['current_story'] = len(room['stories']) - 1 if room['stories'] else None
        # 初始化揭晓标志
        if room['current_story'] is not None:
            room['reveal_answer_flag'] = False
    return jsonify({'success': True, 'count': len(room['stories'])})

@app.route('/api/set_story', methods=['POST'])
def set_story():
    data = request.json
    code = data.get('code')
    nickname = data.get('nickname')
    idx = data.get('index')
    if not (code and nickname and isinstance(idx, int)):
        return jsonify({'error': '参数不完整'}), 400
    with rooms_lock:
        room = rooms.get(code)
        if not room:
            return jsonify({'error': '房间不存在'}), 404
        if room['owner'] != nickname:
            return jsonify({'error': '只有房主可以切换题目'}), 403
        if 'stories' not in room or not room['stories']:
            return jsonify({'error': '题库为空'}), 400
        if not (0 <= idx < len(room['stories'])):
            return jsonify({'error': '题目索引超出范围'}), 400
        room['current_story'] = idx
        # 插入系统消息
        room['messages'].append({'role': 'system', 'content': '房主已切换其他题目', 'nickname': '系统'})
        # 清空 AI 上下文和问题库（新故事重新开始）
        room['ai_context'] = []
        room['question_bank'] = []
        room['passed'] = False
        # 初始化揭晓标志
        room['reveal_answer_flag'] = False
    return jsonify({'success': True})

@app.route('/api/get_current_story', methods=['POST'])
def get_current_story():
    data = request.json
    code = data.get('code')
    if not code:
        return jsonify({'error': '参数不完整'}), 400
    with rooms_lock:
        room = rooms.get(code)
        if not room or 'stories' not in room or room.get('current_story') is None:
            return jsonify({'error': '暂无题目'}), 404
        story = room['stories'][room['current_story']]
        victory_condition = story.get('victory_condition', '')
        answer = story.get('answer', '') if room.get('reveal_answer_flag') else ''
        return jsonify({
            'surface': story.get('surface', ''),
            'victory_condition': victory_condition,
            'answer': answer
        })

@app.route('/api/reveal_answer', methods=['POST'])
def reveal_answer():
    data = request.json
    code = data.get('code')
    nickname = data.get('nickname')
    if not (code and nickname):
        return jsonify({'error': '参数不完整'}), 400
    with rooms_lock:
        room = rooms.get(code)
        if not room:
            return jsonify({'error': '房间不存在'}), 404
        if room['owner'] != nickname:
            return jsonify({'error': '只有房主可以揭晓答案'}), 403
        room['reveal_answer_flag'] = True
        # 插入系统消息
        story = room['stories'][room['current_story']]
        room['messages'].append({'role': 'system', 'content': f"房主已揭晓答案：{story.get('answer', '')}", 'nickname': '系统'})
    return jsonify({'success': True})

@app.route('/story_plaza')
def story_plaza():
    """故事广场页面"""
    return render_template('story_plaza.html')

@app.route('/api/upload_to_plaza', methods=['POST'])
def upload_to_plaza():
    """上传故事到广场"""
    name = request.form.get('name')
    password = request.form.get('password')  # 新增密码字段
    if not name:
        return jsonify({'error': '请填写故事名称'}), 400
    if not password:
        return jsonify({'error': '请填写上传密码'}), 400
    if 'file' not in request.files:
        return jsonify({'error': '没有选择文件'}), 400
    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': '没有选择文件'}), 400
    if not file.filename.endswith('.json'):
        return jsonify({'error': '只支持JSON文件'}), 400
    # 检查文件大小限制 (20MB = 20 * 1024 * 1024 bytes)
    file.seek(0, 2)  # 移动到文件末尾
    file_size = file.tell()  # 获取文件大小
    file.seek(0)  # 重置文件指针到开头
    if file_size > 20 * 1024 * 1024:  # 20MB
        return jsonify({'error': '文件大小不能超过20MB'}), 400
    try:
        # 读取文件内容
        content = file.read().decode('utf-8')
        story_data = json.loads(content)
        # 生成唯一编号
        global STORY_COUNTER
        story_id = f"#{STORY_COUNTER:05d}"
        STORY_COUNTER += 1
        save_story_counter(STORY_COUNTER)
        # 包装故事数据，包含密码
        plaza_story = {
            'name': name,
            'id': story_id,
            'surface': story_data.get('surface', ''),
            'data': story_data,
            'password': password  # 保存密码用于后续修改
        }
        # 生成唯一文件名
        import uuid
        filename = f"{uuid.uuid4()}.json"
        # 保存到待审核目录，管理员审核后发布
        filepath = os.path.join(STORY_UPLOAD_DIR, filename)
        # 保存文件
        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(plaza_story, f, ensure_ascii=False, indent=2)
        return jsonify({'success': True, 'message': '故事已发布到广场', 'id': story_id})
    except Exception as e:
        return jsonify({'error': f'文件解析失败: {str(e)}'}), 400

@app.route('/api/submit_story_online', methods=['POST'])
def submit_story_online():
    """在线编辑并提交故事到广场"""
    try:
        if request.is_json:
            data = request.get_json(silent=True) or {}
            name = data.get('name', '').strip()
            surface = data.get('surface', '').strip()
            answer = data.get('answer', '').strip()
            additional = data.get('additional', '').strip()
            victory_condition = data.get('victory_condition', '').strip()
            password = data.get('password', '').strip()  # 新增密码字段
        else:
            name = (request.form.get('name') or '').strip()
            surface = (request.form.get('surface') or '').strip()
            answer = (request.form.get('answer') or '').strip()
            additional = (request.form.get('additional') or '').strip()
            victory_condition = (request.form.get('victory_condition') or '').strip()
            password = (request.form.get('password') or '').strip()  # 新增密码字段

        if not name:
            return jsonify({'error': '请填写故事名称'}), 400
        if not surface:
            return jsonify({'error': '请填写汤面'}), 400
        if not answer:
            return jsonify({'error': '请填写汤底'}), 400
        if not victory_condition:
            return jsonify({'error': '请填写获胜条件'}), 400
        # 密码可选 — 为空时可无密码发布

        # 生成唯一编号
        global STORY_COUNTER
        story_id = f"#{STORY_COUNTER:05d}"
        STORY_COUNTER += 1
        save_story_counter(STORY_COUNTER)

        # 故事数据
        story_data = {
            'surface': surface,
            'answer': answer,
            'additional': additional,
            'victory_condition': victory_condition
        }

        plaza_story = {
            'name': name,
            'id': story_id,
            'surface': surface,
            'data': story_data,
            'password': password  # 保存密码用于后续修改
        }

        # 直接保存到发布目录，跳过审核
        filename = f"{uuid.uuid4()}.json"
        filepath = os.path.join(STORY_RELEASE_DIR, filename)
        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(plaza_story, f, ensure_ascii=False, indent=2)

        return jsonify({'success': True, 'message': '故事已发布到广场', 'id': story_id})
    except Exception as e:
        return jsonify({'error': f'提交失败: {str(e)}'}), 500

@app.route('/api/edit_story', methods=['POST'])
def edit_story():
    """修改已上传的故事"""
    try:
        if request.is_json:
            data = request.get_json(silent=True) or {}
        else:
            data = request.form.to_dict()

        story_id = data.get('story_id', '').strip()
        password = data.get('password', '').strip()
        new_surface = data.get('surface', '').strip()
        new_answer = data.get('answer', '').strip()
        new_additional = data.get('additional', '').strip()
        new_victory_condition = data.get('victory_condition', '').strip()

        if not story_id:
            return jsonify({'error': '请输入故事编号'}), 400
        if not password:
            return jsonify({'error': '请输入密码'}), 400

        # 在发布目录中查找匹配的故事
        story_file = None
        story_data = None
        for filename in os.listdir(STORY_RELEASE_DIR):
            if filename.endswith('.json'):
                try:
                    with open(os.path.join(STORY_RELEASE_DIR, filename), 'r', encoding='utf-8') as f:
                        temp_story = json.load(f)
                    if temp_story.get('id') == story_id:
                        story_file = filename
                        story_data = temp_story
                        break
                except Exception:
                    continue

        if not story_file:
            return jsonify({'error': '未找到对应的故事'}), 404

        # 验证密码
        if story_data.get('password') != password:
            return jsonify({'error': '密码错误'}), 403

        # 更新故事数据
        if new_surface:
            story_data['surface'] = new_surface
            story_data['data']['surface'] = new_surface
        if new_answer:
            story_data['data']['answer'] = new_answer
        if new_additional:
            story_data['data']['additional'] = new_additional
        if new_victory_condition:
            story_data['data']['victory_condition'] = new_victory_condition

        # 保存更新后的文件
        filepath = os.path.join(STORY_RELEASE_DIR, story_file)
        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(story_data, f, ensure_ascii=False, indent=2)

        return jsonify({'success': True, 'message': '故事修改成功'})
    except Exception as e:
        return jsonify({'error': f'修改失败: {str(e)}'}), 500

@app.route('/api/get_story_for_edit', methods=['POST'])
def get_story_for_edit():
    """获取故事内容用于编辑"""
    try:
        data = request.get_json(silent=True) or {}
        story_id = data.get('story_id', '').strip()
        password = data.get('password', '').strip()

        if not story_id:
            return jsonify({'error': '请输入故事编号'}), 400
        if not password:
            return jsonify({'error': '请输入密码'}), 400

        # 在发布目录中查找匹配的故事
        for filename in os.listdir(STORY_RELEASE_DIR):
            if filename.endswith('.json'):
                try:
                    with open(os.path.join(STORY_RELEASE_DIR, filename), 'r', encoding='utf-8') as f:
                        story_data = json.load(f)
                    if story_data.get('id') == story_id:
                        # 验证密码
                        if story_data.get('password') != password:
                            return jsonify({'error': '密码错误'}), 403

                        # 返回故事内容（不包含密码）
                        return jsonify({
                            'success': True,
                            'story': {
                                'id': story_data.get('id'),
                                'name': story_data.get('name'),
                                'surface': story_data['data'].get('surface', ''),
                                'answer': story_data['data'].get('answer', ''),
                                'additional': story_data['data'].get('additional', ''),
                                'victory_condition': story_data['data'].get('victory_condition', '')
                            }
                        })
                except Exception:
                    continue

        return jsonify({'error': '未找到对应的故事'}), 404
    except Exception as e:
        return jsonify({'error': f'获取失败: {str(e)}'}), 500

@app.route('/api/admin_view_story', methods=['POST'])
def admin_view_story():
    """管理员查看故事详情"""
    if not session.get('admin_logged_in'):
        return jsonify({'error': '未登录'}), 403

    filename = request.form.get('filename')
    if not filename:
        return jsonify({'error': '参数不完整'}), 400

    filepath = os.path.join(STORY_RELEASE_DIR, filename)
    if not os.path.exists(filepath):
        filepath = os.path.join(STORY_UPLOAD_DIR, filename)
    if not os.path.exists(filepath):
        return jsonify({'error': '文件不存在'}), 404

    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            story_data = json.load(f)

        return jsonify({
            'success': True,
            'story': {
                'id': story_data.get('id'),
                'name': story_data.get('name'),
                'surface': story_data['data'].get('surface', ''),
                'answer': story_data['data'].get('answer', ''),
                'additional': story_data['data'].get('additional', ''),
                'victory_condition': story_data['data'].get('victory_condition', '')
            }
        })
    except Exception as e:
        return jsonify({'error': f'读取失败: {str(e)}'}), 500

@app.route('/api/search_stories', methods=['GET'])
def search_stories():
    """搜索故事（用于下拉菜单）"""
    query = request.args.get('q', '').strip().lower()
    stories = []

    # 获取已发布的故事
    for filename in os.listdir(STORY_RELEASE_DIR):
        if filename.endswith('.json'):
            try:
                with open(os.path.join(STORY_RELEASE_DIR, filename), 'r', encoding='utf-8') as f:
                    story_data = json.load(f)

                story_info = {
                    'name': story_data.get('name', ''),
                    'id': story_data.get('id', ''),
                    'surface': story_data.get('surface', ''),
                    'filename': filename
                }

                # 如果有查询条件，进行筛选
                if query:
                    name_match = query in story_info['name'].lower()
                    id_match = query in story_info['id'].lower()
                    surface_match = query in story_info['surface'].lower()

                    if name_match or id_match or surface_match:
                        stories.append(story_info)
                else:
                    stories.append(story_info)

            except Exception as e:
                print(f"Error reading {filename}: {e}")

    # 按编号排序
    stories.sort(key=lambda x: x.get('id', ''))
    return jsonify({'stories': stories})

@app.route('/api/get_plaza_stories', methods=['GET'])
def get_plaza_stories():
    """获取故事广场列表"""
    stories = []
    # 获取已发布的故事
    for filename in os.listdir(STORY_RELEASE_DIR):
        if filename.endswith('.json'):
            try:
                with open(os.path.join(STORY_RELEASE_DIR, filename), 'r', encoding='utf-8') as f:
                    story_data = json.load(f)
                    # 只显示名称和编号和汤面
                    stories.append({
                        'name': story_data.get('name', ''),
                        'id': story_data.get('id', ''),
                        'surface': story_data.get('surface', ''),
                        'filename': filename
                    })
            except Exception as e:
                print(f"Error reading {filename}: {e}")
    return jsonify({'stories': stories})

@app.route('/api/get_pending_stories', methods=['GET'])
def get_pending_stories():
    """获取待审核故事列表（管理员专用）"""
    if not session.get('admin_logged_in'):
        return jsonify({'error': '未登录'}), 403
    stories = []
    for filename in os.listdir(STORY_UPLOAD_DIR):
        if filename.endswith('.json'):
            try:
                with open(os.path.join(STORY_UPLOAD_DIR, filename), 'r', encoding='utf-8') as f:
                    story_data = json.load(f)
                    stories.append({
                        'name': story_data.get('name', ''),
                        'id': story_data.get('id', ''),
                        'surface': story_data.get('surface', ''),
                        'filename': filename
                    })
            except Exception as e:
                print(f"Error reading {filename}: {e}")
    return jsonify({'stories': stories})

@app.route('/api/delete_released_story', methods=['POST'])
def delete_released_story():
    """删除已发布的故事（管理员）"""
    if not session.get('admin_logged_in'):
        return jsonify({'error': '未登录'}), 403
    filename = request.form.get('filename')
    if not filename:
        return jsonify({'error': '参数不完整'}), 400
    filepath = os.path.join(STORY_RELEASE_DIR, filename)
    if not os.path.exists(filepath):
        filepath = os.path.join(STORY_UPLOAD_DIR, filename)
    if not os.path.exists(filepath):
        return jsonify({'error': '文件不存在'}), 404
    try:
        os.remove(filepath)
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'error': f'操作失败: {str(e)}'}), 500

# 【凯喵推子】批量删除故事（无需密码，只需确认）
@app.route('/api/delete_stories', methods=['POST'])
def delete_stories():
    """批量删除已发布的故事"""
    data = request.json
    filenames = data.get('filenames', [])
    if not filenames or not isinstance(filenames, list):
        return jsonify({'error': '参数不完整'}), 400
    deleted = 0
    errors = []
    for filename in filenames:
        filepath = os.path.join(STORY_RELEASE_DIR, filename)
        if os.path.exists(filepath):
            try:
                os.remove(filepath)
                deleted += 1
            except Exception as e:
                errors.append(f'{filename}: {str(e)}')
        else:
            errors.append(f'{filename}: 文件不存在')
    return jsonify({'success': True, 'deleted': deleted, 'errors': errors})

@app.route('/api/approve_story', methods=['POST'])
def approve_story():
    """审核通过故事"""
    if not session.get('admin_logged_in'):
        return jsonify({'error': '未登录'}), 403
    filename = request.form.get('filename')
    if not filename:
        return jsonify({'error': '参数不完整'}), 400
    source_path = os.path.join(STORY_UPLOAD_DIR, filename)
    target_path = os.path.join(STORY_RELEASE_DIR, filename)
    if not os.path.exists(source_path):
        return jsonify({'error': '文件不存在'}), 404
    try:
        # 直接移动文件，保留编号和名称
        import shutil
        shutil.move(source_path, target_path)
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'error': f'操作失败: {str(e)}'}), 500

@app.route('/api/reject_story', methods=['POST'])
def reject_story():
    """拒绝故事"""
    if not session.get('admin_logged_in'):
        return jsonify({'error': '未登录'}), 403
    filename = request.form.get('filename')
    if not filename:
        return jsonify({'error': '参数不完整'}), 400
    filepath = os.path.join(STORY_UPLOAD_DIR, filename)
    if not os.path.exists(filepath):
        return jsonify({'error': '文件不存在'}), 404
    try:
        os.remove(filepath)
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'error': f'操作失败: {str(e)}'}), 500

@app.route('/api/load_story_from_plaza', methods=['POST'])
def load_story_from_plaza():
    """从故事广场加载故事到房间"""
    data = request.json
    code = data.get('code')
    nickname = data.get('nickname')
    filename = data.get('filename')
    if not (code and nickname and filename):
        return jsonify({'error': '参数不完整'}), 400
    with rooms_lock:
        room = rooms.get(code)
        if not room:
            return jsonify({'error': '房间不存在'}), 404
        if room['owner'] != nickname:
            return jsonify({'error': '只有房主可以加载故事'}), 403
        filepath = os.path.join(STORY_RELEASE_DIR, filename)
        if not os.path.exists(filepath):
            return jsonify({'error': '故事不存在'}), 404
        try:
            with open(filepath, 'r', encoding='utf-8') as f:
                plaza_story = json.load(f)
            if 'stories' not in room:
                room['stories'] = []
            # 只导入data字段
            room['stories'].append(plaza_story['data'])
            room['current_story'] = len(room['stories']) - 1
            room['reveal_answer_flag'] = False
            return jsonify({'success': True, 'count': len(room['stories'])})
        except Exception as e:
            return jsonify({'error': f'加载失败: {str(e)}'}), 500

# 【凯喵推子 / 全AI修改】新增 API — AI 生成海龟汤故事
# 使用当前房间的 API 配置（支持故障转移）生成故事
# 内部调用 build_generation_prompt 构建 prompt
@app.route('/api/ai_generate_story', methods=['POST'])
def ai_generate_story():
    """AI生成海龟汤故事"""
    data = request.json
    code = data.get('code')
    nickname = data.get('nickname')
    prompt = (data.get('prompt') or '').strip()
    if not (code and nickname):
        return jsonify({'error': '参数不完整'}), 400
    with rooms_lock:
        room = rooms.get(code)
        if not room:
            return jsonify({'error': '房间不存在'}), 404
        if room['owner'] != nickname:
            return jsonify({'error': '只有房主可以生成故事'}), 403
        profiles = room.get('api_profiles', [])
        if not profiles:
            profiles = [{'base_url': room['base_url'], 'api_key': room['api_key'], 'model': room['model']}]
    # 构建生成消息
    system_content = build_generation_prompt(prompt)
    messages = [{'role': 'system', 'content': system_content}]
    if prompt:
        messages.append({'role': 'user', 'content': f'额外要求：{prompt}'})
    try:
        reply, used_idx = call_llm_with_failover(profiles, messages, timeout=90)
    except Exception as e:
        return jsonify({'error': f'AI生成失败: {str(e)}'}), 500
    # 从回复中提取JSON
    story_data = extract_json_from_reply(reply)
    if not story_data:
        return jsonify({'error': 'AI返回格式异常，请重试'}), 500
    story = {
        'surface': story_data.get('surface', ''),
        'answer': story_data.get('answer', ''),
        'additional': story_data.get('additional', ''),
        'victory_condition': story_data.get('victory_condition', '')
    }
    if not story['surface'] or not story['answer']:
        return jsonify({'error': 'AI生成的故事不完整（缺少汤面或汤底）'}), 500
    with rooms_lock:
        room = rooms.get(code)
        if not room:
            return jsonify({'error': '房间不存在'}), 404
        if 'stories' not in room:
            room['stories'] = []
        room['stories'].append(story)
        room['current_story'] = len(room['stories']) - 1
        room['reveal_answer_flag'] = False
        # 初始化微调上下文
        room['ai_gen_context'] = [
            {'role': 'system', 'content': build_refinement_prompt(story)},
            {'role': 'assistant', 'content': f'故事已生成成功。\n{reply}'}
        ]
    return jsonify({'success': True, 'story': story})
# 【凯喵推子 / 全AI修改】新增 API — 多轮对话微调故事
# 维护一个独立的 ai_gen_context 来保存微调对话历史
# 每次调用会提取 AI 回复中的 JSON story 并更新到 room['stories']
@app.route('/api/ai_refine_story', methods=['POST'])
def ai_refine_story():
    """多轮对话微调故事"""
    data = request.json
    code = data.get('code')
    nickname = data.get('nickname')
    message = (data.get('message') or '').strip()
    if not (code and nickname and message):
        return jsonify({'error': '参数不完整'}), 400
    with rooms_lock:
        room = rooms.get(code)
        if not room:
            return jsonify({'error': '房间不存在'}), 404
        if room['owner'] != nickname:
            return jsonify({'error': '只有房主可以调整故事'}), 403
        profiles = room.get('api_profiles', [])
        if not profiles:
            profiles = [{'base_url': room['base_url'], 'api_key': room['api_key'], 'model': room['model']}]
        if 'ai_gen_context' not in room or not room['ai_gen_context']:
            if 'stories' not in room or room.get('current_story') is None:
                return jsonify({'error': '没有可调整的故事'}), 400
            current = room['stories'][room['current_story']]
            room['ai_gen_context'] = [{'role': 'system', 'content': build_refinement_prompt(current)}]
        context = list(room['ai_gen_context'])
        context.append({'role': 'user', 'content': message})
    try:
        reply, used_idx = call_llm_with_failover(profiles, context, timeout=90)
    except Exception as e:
        return jsonify({'error': f'AI调整失败: {str(e)}'}), 500
    # 从回复中提取JSON story
    story_data = extract_json_from_reply(reply)
    text_reply = reply
    if story_data:
        updated_story = {
            'surface': story_data.get('surface', ''),
            'answer': story_data.get('answer', ''),
            'additional': story_data.get('additional', ''),
            'victory_condition': story_data.get('victory_condition', '')
        }
        if not updated_story['surface'] or not updated_story['answer']:
            return jsonify({'error': 'AI返回的故事数据不完整'}), 500
    else:
        return jsonify({'error': 'AI返回格式异常，请重试'}), 500
    with rooms_lock:
        room = rooms.get(code)
        if not room:
            return jsonify({'error': '房间不存在'}), 404
        if 'stories' in room and room.get('current_story') is not None:
            room['stories'][room['current_story']] = updated_story
        room['ai_gen_context'].append({'role': 'user', 'content': message})
        room['ai_gen_context'].append({'role': 'assistant', 'content': reply})
        if len(room['ai_gen_context']) > 40:
            room['ai_gen_context'] = [room['ai_gen_context'][0]] + room['ai_gen_context'][-39:]
    return jsonify({'reply': '故事已更新', 'story': updated_story})

# 【凯喵推子 / 全AI修改】新增 API — 获取房间问题库
@app.route('/api/get_question_bank', methods=['POST'])
def get_question_bank():
    """获取房间问题库"""
    data = request.json
    code = data.get('code')
    if not code:
        return jsonify({'error': '参数不完整'}), 400
    with rooms_lock:
        room = rooms.get(code)
        if not room:
            return jsonify({'error': '房间不存在'}), 404
        bank = room.get('question_bank', [])
    return jsonify({'questions': bank})

# 【凯喵推子 / 全AI修改】新增 API — 故事广场 AI 生成并直接发布
# 使用前端传入的 API 配置（profiles），生成后直接保存到广场
@app.route('/api/ai_generate_plaza', methods=['POST'])
def ai_generate_plaza():
    """故事广场AI生成故事（使用前端传入的API配置）"""
    data = request.json
    prompt = (data.get('prompt') or '').strip()
    password = (data.get('password') or '').strip()
    profiles = data.get('profiles', [])
    if not password:
        return jsonify({'error': '请填写管理密码'}), 400
    if not profiles:
        return jsonify({'error': '请选择API配置'}), 400
    # 【凯喵推子】支持自定义预设消息列表；无预设时使用默认 hardcoded prompt
    preset_messages = data.get('preset_messages', [])
    if preset_messages and len(preset_messages) > 0:
        messages = list(preset_messages)
        if prompt:
            messages.append({'role': 'user', 'content': prompt})
    else:
        system_content = build_generation_prompt(prompt)
        messages = [{'role': 'system', 'content': system_content}]
        if prompt:
            messages.append({'role': 'user', 'content': f'额外要求：{prompt}'})
    try:
        reply, used_idx = call_llm_with_failover(profiles, messages, timeout=90)
    except Exception as e:
        return jsonify({'error': f'AI生成失败: {str(e)}'}), 500
    story_data = extract_json_from_reply(reply)
    if not story_data:
        return jsonify({'error': 'AI返回格式异常，请重试'}), 500
    story = {
        'surface': story_data.get('surface', ''),
        'answer': story_data.get('answer', ''),
        'additional': story_data.get('additional', ''),
        'victory_condition': story_data.get('victory_condition', '')
    }
    if not story['surface'] or not story['answer']:
        return jsonify({'error': 'AI生成的故事不完整'}), 500
    # 直接保存到广场
    global STORY_COUNTER
    story_id = f"#{STORY_COUNTER:05d}"
    STORY_COUNTER += 1
    save_story_counter(STORY_COUNTER)
    plaza_story = {
        'name': f'AI生成故事{story_id}',
        'id': story_id,
        'surface': story['surface'],
        'data': story,
        'password': password
    }
    filename = f"{uuid.uuid4()}.json"
    filepath = os.path.join(STORY_RELEASE_DIR, filename)
    with open(filepath, 'w', encoding='utf-8') as f:
        json.dump(plaza_story, f, ensure_ascii=False, indent=2)
    return jsonify({'success': True, 'story': story, 'id': story_id})

# 【凯喵推子 / 全AI修改】预设管理 API（PRESETS_DIR 已在顶部定义）
@app.route('/api/presets', methods=['GET'])
def list_presets():
    """获取预设列表"""
    presets = []
    if not os.path.exists(PRESETS_DIR):
        return jsonify({'presets': []})
    for fname in os.listdir(PRESETS_DIR):
        if fname.endswith('.json'):
            try:
                with open(os.path.join(PRESETS_DIR, fname), 'r', encoding='utf-8') as f:
                    data = json.load(f)
                presets.append({
                    'id': data.get('id', fname.replace('.json', '')),
                    'name': data.get('name', fname.replace('.json', '')),
                    'filename': fname,
                    'is_default': fname == 'default.json'
                })
            except:
                continue
    return jsonify({'presets': presets})

@app.route('/api/presets/get', methods=['POST'])
def get_preset():
    """获取单个预设内容"""
    data = request.json
    filename = data.get('filename', 'default.json')
    filepath = os.path.join(PRESETS_DIR, filename)
    if not os.path.exists(filepath):
        return jsonify({'error': '预设不存在'}), 404
    with open(filepath, 'r', encoding='utf-8') as f:
        preset = json.load(f)
    return jsonify({'preset': preset})

@app.route('/api/presets/save', methods=['POST'])
def save_preset():
    """保存预设"""
    data = request.json
    name = data.get('name', '').strip()
    messages = data.get('messages', [])
    if not name or not messages:
        return jsonify({'error': '参数不完整'}), 400
    safe_name = name.replace('/', '_').replace('\\', '_')
    filename = f"{safe_name}.json"
    preset_data = {
        'id': safe_name,
        'name': name,
        'messages': messages
    }
    filepath = os.path.join(PRESETS_DIR, filename)
    with open(filepath, 'w', encoding='utf-8') as f:
        json.dump(preset_data, f, ensure_ascii=False, indent=2)
    return jsonify({'success': True, 'filename': filename})

@app.route('/api/presets/delete', methods=['POST'])
def delete_preset():
    """删除自定义预设"""
    data = request.json
    filename = data.get('filename', '')
    if not filename:
        return jsonify({'error': '参数不完整'}), 400
    if filename == 'default.json':
        return jsonify({'error': '不能删除默认预设'}), 403
    filepath = os.path.join(PRESETS_DIR, filename)
    if os.path.exists(filepath):
        os.remove(filepath)
        return jsonify({'success': True})
    return jsonify({'error': '文件不存在'}), 404

@app.route('/api/presets/restore_default', methods=['POST'])
def restore_default_preset():
    """恢复默认预设"""
    import shutil
    filepath = os.path.join(PRESETS_DIR, 'default.json')
    if os.path.exists(filepath):
        os.remove(filepath)
    # 重新创建默认预设
    default_preset = [
        {"role": "system", "content": "你是一个海龟汤（Turtle Soup）谜题创作大师。海龟汤是一种推理游戏，玩家通过提问来还原故事真相。请根据用户的要求创作海龟汤谜题。"},
        {"role": "system", "content": "请严格按照以下JSON格式输出，不要包含除了JSON以外的任何内容：\n{\n  \"surface\": \"汤面\",\n  \"answer\": \"汤底\",\n  \"additional\": \"补充说明\",\n  \"victory_condition\": \"胜利条件\"\n}\n\n要求：故事要有创意，汤底要完整，胜利条件要清晰。"}
    ]
    with open(filepath, 'w', encoding='utf-8') as f:
        json.dump({'id': 'default', 'name': '默认预设', 'messages': default_preset}, f, ensure_ascii=False, indent=2)
    return jsonify({'success': True, 'preset': {'id': 'default', 'name': '默认预设', 'messages': default_preset}})

@app.route('/admin', methods=['GET', 'POST'])
def admin_panel():
    if request.method == 'POST':
        username = request.form.get('username')
        password = request.form.get('password')
        # 每次登录实时读取 config.json，避免缓存问题
        import json as _json
        try:
            with open('config.json', 'r', encoding='utf-8') as _f:
                _cfg = _json.load(_f)
            _admin = _cfg.get('admin', {})
            _u = _admin.get('username', ADMIN_USERNAME)
            _p = _admin.get('password', ADMIN_PASSWORD)
        except:
            _u, _p = ADMIN_USERNAME, ADMIN_PASSWORD
        if username == _u and password == _p:
            session['admin_logged_in'] = True
            return redirect('/admin')
        else:
            return render_template('admin_login.html', error='账号或密码错误')
    if not session.get('admin_logged_in'):
        return render_template('admin_login.html')
    # 展示房间信息
    room_list = []
    with rooms_lock:
        for code, room in rooms.items():
            room_list.append({
                'code': code,
                'owner': room['owner'],
                'members': list(room['members'].keys()),
                'invite_code': code
            })
    return render_template('admin_panel.html', rooms=room_list)

@app.route('/admin/delete_room', methods=['POST'])
def admin_delete_room():
    if not session.get('admin_logged_in'):
        return jsonify({'error': '未登录'}), 403
    code = request.form.get('code')
    with rooms_lock:
        if code in rooms:
            del rooms[code]
            return jsonify({'success': True})
        else:
            return jsonify({'error': '房间不存在'}), 404

@app.route('/api/get_options', methods=['GET'])
def get_options():
    """获取下拉选项（仅管理员可见，防止泄露 API Key）"""
    if not session.get('admin_logged_in'):
        # 非管理员只返回模型列表，不返回 API Key 和 base_url
        safe_options = {
            'models': OPTIONS.get('models', []),
            'base_urls': [],
            'api_keys': []
        }
        return jsonify({'options': safe_options})
    return jsonify({'options': OPTIONS})

@app.route('/api/save_options', methods=['POST'])
def save_options_endpoint():
    """保存下拉选项（管理员）"""
    if not session.get('admin_logged_in'):
        return jsonify({'error': '未登录'}), 403
    data = request.get_json(silent=True) or {}
    models = data.get('models', [])
    base_urls = data.get('base_urls', [])
    api_keys = data.get('api_keys', [])
    if not isinstance(models, list) or not isinstance(base_urls, list) or not isinstance(api_keys, list):
        return jsonify({'error': '参数格式错误'}), 400
    # 规范化为字符串并去重/去空
    def normalize(lst):
        result = []
        for x in lst:
            s = str(x).strip()
            if s and s not in result:
                result.append(s)
        return result
    new_options = {
        'models': normalize(models),
        'base_urls': normalize(base_urls),
        'api_keys': normalize(api_keys)
    }
    global OPTIONS
    OPTIONS = new_options
    save_options(OPTIONS)
    return jsonify({'success': True})

@app.route('/api/get_announcements', methods=['GET'])
def get_announcements():
    """获取公告"""
    return jsonify({'content': ANNOUNCEMENTS or ''})

@app.route('/api/save_announcements', methods=['POST'])
def update_announcements():
    """保存公告（管理员）"""
    if not session.get('admin_logged_in'):
        return jsonify({'error': '未登录'}), 403
    data = request.get_json(silent=True) or {}
    content = str(data.get('content', ''))
    global ANNOUNCEMENTS
    ANNOUNCEMENTS = content
    save_announcements(ANNOUNCEMENTS)
    return jsonify({'success': True})

# 【凯喵推子】API 配置保存到 session
@app.route('/api/save_my_config', methods=['POST'])
def save_my_config():
    data = request.get_json(silent=True) or {}
    session['api_profiles'] = data.get('profiles', [])
    return jsonify({'success': True})

@app.route('/api/load_my_config', methods=['GET'])
def load_my_config():
    return jsonify({'profiles': session.get('api_profiles', [])})

if __name__ == '__main__':
    # 每天凌晨3点清空所有房间
    def daily_cleanup_task():
        while True:
            now = datetime.datetime.now()
            # 计算下一次凌晨3点
            next_run = (now + datetime.timedelta(days=1)).replace(hour=3, minute=0, second=0, microsecond=0)
            # 若当前已过3点，则从明天的3点开始
            if now.hour < 3:
                next_run = now.replace(hour=3, minute=0, second=0, microsecond=0)
            sleep_seconds = (next_run - now).total_seconds()
            time.sleep(max(1, int(sleep_seconds)))
            try:
                with rooms_lock:
                    rooms.clear()
                print('[定时任务] 已在凌晨3点清空所有房间')
            except Exception as e:
                print(f'[定时任务] 清理失败: {e}')

    threading.Thread(target=daily_cleanup_task, daemon=True).start()
    app.run(host='0.0.0.0', port=5000, debug=True)