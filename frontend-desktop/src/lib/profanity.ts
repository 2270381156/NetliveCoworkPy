/**
 * 用户骂人检测（中 / 英 / 葡）。
 *
 * 这是**彩蛋触发器**，不是内容审核：宁可漏，不可误伤——误判一次就是无缘无故往用户脸上
 * 扔粑粑，比漏掉十次难受得多。所以分两档：
 *
 *   HARD  强脏话。不管骂谁，命中即算。
 *   SOFT  单纯的贬义词（垃圾 / stupid / burro…）。必须**同时**出现指向我们的称呼
 *         （你 / 这破玩意 / you / this thing / você / isso）才算——"我今天真是蠢"
 *         骂的是他自己，不该触发。
 *
 * 英文和葡文一律加 \\b 词边界，避免 Scunthorpe 那类误伤（assess 里有 ass、
 * classic 里有 ass、Dumbarton 里有 dumb）。中文没有词边界，靠**否定环视**挡掉同形词，
 * 见下面 zh 那条的注释——「操作」「草稿」在本产品里出现频率极高，挡不住就废了。
 *
 * 词源：公开的多语脏话清单（LDNOOBW 等）+ 人工筛。**故意剔掉**了三类不该触发的词：
 *   - 身份词（同性恋相关称谓等）：拿它当"骂人"来判本身就是冒犯
 *   - 生理 / 医学 / 毒品名词：用户正经讨论时也会出现
 *   - 清单里混进来的中性词（葡语那份里甚至有 cerveja「啤酒」、comer「吃」）
 */

export type AbuseTier = 'hard' | 'soft'
export type AbuseLang = 'zh' | 'en' | 'pt'

export interface AbuseHit {
  tier: AbuseTier
  lang: AbuseLang
  /** 命中的原文片段，写进上报备注用（会话本来就整包上传，这里不额外泄露什么） */
  term: string
}

// JS 的 \\b 是 ASCII 的：ê / á / ç 在它眼里是**非单词字符**，于是 '\\bvoc[êe]s?\\b' 匹配
// voce 能中、匹配 você 直接失效——葡语带重音的词会漏掉一半。所以词边界一律用 Unicode
// 属性自己拼，并给正则加 u 标志。
const NB = '(?<![\\p{L}\\p{N}_])'   // 左边不能是字母/数字
const NA = '(?![\\p{L}\\p{N}_])'    // 右边不能是字母/数字

// ── HARD：强脏话，不看指向 ────────────────────────────────────────────────────

// 中文单字脏话（操 / 草 / 靠）必须用否定环视排除同形词，否则本产品里满屏误报：
//   操 → 操作、操心、体操、操盘、操练、操场、操控、操纵
//   草 → 草稿、草图、草案、除草、水草、草率、草莓
// 「你妈 / 他妈」不加环视：这两个组合本身没有正经用法。
const ZH_HARD = new RegExp([
  // 操/草/艹/肏 及其变体
  '(?<![体广])操(?![作心练场纵控守办盘])',
  '(?<![除割水花香稻甘])草(?![稿图地原木药莓率案根丛])',
  '艹|肏|卧槽|靠北|靠杯',
  // 「我靠」只在当感叹词时算——后面直接接名词是「依靠」（我靠这个脚本跑批）
  '我靠(?=[，。！？、,.!?~ ]|$)',
  // 妈系
  '你妈|他妈|她妈|妈的|妈了个|尼玛|泥马|妮玛|你娘|干你娘|草泥马|马勒戈壁|我日|日你',
  '特么|tmd|nmsl|cnm|wcnm|mmp',
  // 傻系
  '傻逼|傻B|傻b|沙比|煞笔|傻叉|傻缺|二逼|2b|傻子|蠢猪',
  // 生殖器/下三路
  '鸡巴|几把|jb|屌你|屌爆|吊你',
  // 人身攻击
  '王八蛋|混蛋|混账|浑蛋|畜生|畜牲|杂种|狗娘养|狗东西|狗屎|狗腿',
  '贱人|贱货|婊子|人渣|渣滓|废物点心',
  '脑残|智障|弱智|低能儿|白痴|痴呆|神经病|精神病|有病吧',
  // 祈使
  '滚蛋|滚开|滚粗|给我滚|去死|死开|找死|该死|去你(的|妈)',
].join('|'), 'i')

const EN_HARD = new RegExp(NB + '(' + [
  'fuck\\w*', 'motherfuck\\w*', 'mofo', 'stfu', 'wtf', 'gtfo', 'fml',
  'f[u*@#]ck\\w*', 'fck', 'fuk',
  'shit(s|ty|tier|tiest|ting|ted|head|hole|show|storm)?', 'bullshit', 'sh[i1!*]t', 'horseshit', 'dogshit',
  'bitch\\w*', 'b[i1*]tch',
  'bastard\\w*', 'asshole\\w*', 'arsehole\\w*', 'a[s$*]{2}hole',
  'dumbass', 'jackass', 'smartass', 'ass', 'arse',
  'dick(head|wad|face)?', 'prick', 'cock(sucker)?', 'cunt', 'twat',
  'wanker', 'bollocks', 'bugger', 'douche(bag)?', 'scumbag', 'jerk',
  'goddamn\\w*', 'damn\\w*', 'piss(ed)?\\s*off', 'pissing',
  'screw\\s+(you|this|off)', 'sod\\s+off', 'shut\\s+up',
  'go\\s+to\\s+hell', 'what\\s+the\\s+hell', 'crap\\w*',
].join('|') + ')' + NA, 'iu')

// 葡语：只取真正的辱骂/脏话。**刻意不收**身份词（bicha / veado / paneleiro /
// lésbica 等）与生理、毒品、中性词——那份公开清单里混了不少，照抄会误伤且冒犯。
const PT_HARD = new RegExp(NB + '(' + [
  'caralho', 'porra', 'merda', 'bosta', 'esporra',
  'foda[-\\s]?se', 'fodase', 'foder', 'fode[-\\s]?se', 'fodido', 'foda',
  'puta', 'putaria', 'puta\\s+que\\s+(te\\s+)?pariu', 'filho\\s+da\\s+puta', 'fdp',
  'vai\\s+se\\s+foder', 'vai[-\\s]te\\s+foder', 'vai\\s+tomar\\s+no\\s+cu',
  'cuz[ãa]o', 'cabr[ãa]o', 'corno', 'escroto', 'arrombado',
  'desgra[çc]ado', 'vadia', 'safado', 'cretino', 'canalha',
  'caceta', 'cacete',
].join('|') + ')' + NA, 'iu')

const HARD: Array<[AbuseLang, RegExp]> = [
  ['zh', ZH_HARD],
  ['en', EN_HARD],
  ['pt', PT_HARD],
]

// ── SOFT：贬义词，需要配合指向 ────────────────────────────────────────────────
const ZH_SOFT = new RegExp([
  '垃圾|辣鸡|废物|窝囊废|饭桶|草包|没用|难用|不好用|真烂|太烂|烂透|稀烂',
  '白痴|蠢货|蠢材|愚蠢|笨蛋|笨死|笨得|呆子|没脑子|不长脑子',
  '无能|水平差|离谱|坑爹|坑人|敷衍|糊弄|摆烂|拉胯|有毛病|毛病',
  '傻|蠢|笨',
].join('|'), 'i')

const EN_SOFT = new RegExp(NB + '(' + [
  'stupid', 'idiot(ic)?', 'useless', 'garbage', 'trash', 'rubbish',
  'worthless', 'moron(ic)?', 'dumb(er|est)?', 'pathetic', 'incompetent',
  'lousy', 'awful', 'terrible', 'horrible', 'nonsense', 'clueless',
  'brain\\s*dead', 'braindead', 'suck(s|ed)?', 'joke', 'waste\\s+of\\s+time',
  'ridiculous', 'absurd', 'lame',
].join('|') + ')' + NA, 'iu')

const PT_SOFT = new RegExp(NB + '(' + [
  'idiota', 'burro', 'burra', 'imbecil', 'ot[áa]rio', 'in[úu]til', 'in[úu]teis',
  'lixo', 'p[ée]ssimo', 'horr[íi]vel', 'terr[íi]vel', 'babaca', 'palha[çc]o',
  'incompetente', 'rid[íi]culo', 'patético', 'pat[ée]tico', 'fraco',
  'burrice', 'besteira', 'imprest[áa]vel', 'droga', 'porcaria',
].join('|') + ')' + NA, 'iu')

const SOFT: Array<[AbuseLang, RegExp]> = [
  ['zh', ZH_SOFT],
  ['en', EN_SOFT],
  ['pt', PT_SOFT],
]

// ── 指向我们的称呼 ───────────────────────────────────────────────────────────
// "it" / "this" 单独出现太宽（"this is fine" 也会中），所以英文要求 this + 具体名词。
const TARGET: RegExp[] = [
  new RegExp([
    '你们|你这|你个|你就|你真|你太|你好[歹烂]|你(真|太|好|很|就是|简直|也|又|是不是|到底|怎么)',
    '这[^，。,.!?！？\\s]{0,4}(东西|玩意儿?|软件|程序|助手|机器人|工具|模型|破烂)',
    '这ai|这agent|贵产品|你他',
  ].join('|'), 'i'),
  new RegExp([
    NB + "(you|your|yours|you['’]?re|youre|u|ur)" + NA,
    NB + 'this\\s+(app|thing|tool|ai|assistant|bot|software|product|model|agent|crap|junk)' + NA,
  ].join('|'), 'iu'),
  new RegExp([
    NB + '(voc[êe]s?|teu|tua|seu|sua|isso|isto)' + NA,
    NB + 'esse\\s+(app|treco|tro[çc]o|bot|ai|programa|modelo|assistente)' + NA,
  ].join('|'), 'iu'),
]

/**
 * 检测一段用户输入是不是在骂我们。没骂返回 null。
 */
export function detectAbuse(raw: string): AbuseHit | null {
  const text = (raw || '').trim()
  if (!text) return null

  for (const [lang, re] of HARD) {
    const m = text.match(re)
    if (m) return { tier: 'hard', lang, term: m[0] }
  }

  const aimedAtUs = TARGET.some(re => re.test(text))
  if (!aimedAtUs) return null

  for (const [lang, re] of SOFT) {
    const m = text.match(re)
    if (m) return { tier: 'soft', lang, term: m[0] }
  }
  return null
}
