import { describe, it, expect } from 'vitest'
import { detectAbuse } from '@/lib/profanity'

// [该不该触发, 句子]
const CORPUS: Array<[boolean, string]> = [
  // ── 中文：确实在骂 ─────────────────────────────
  [true, '我操，又崩了'],
  [true, '草，白等半天'],
  [true, '你他妈能不能行'],
  [true, '尼玛这什么破玩意'],
  [true, '傻逼软件'],
  [true, '你这个笨蛋'],
  [true, '你真没用'],
  [true, '这什么垃圾东西'],
  [true, '你就是个废物'],
  [true, '滚蛋吧'],
  [true, '智障设计'],
  [true, '狗屎一样的体验'],
  [true, '你他妈的给我重做'],
  [true, '妈的，白花两小时'],
  [true, '你也太蠢了'],
  [true, '这助手真烂'],

  // ── 中文：正常干活，绝不能触发 ─────────────────
  [false, '这个操作怎么做'],
  [false, '帮我操作一下交换机'],
  [false, '操作系统版本是多少'],
  [false, '这个操作系统不支持'],
  [false, '先写个草稿给我'],
  [false, '草图发我看看'],
  [false, '这份草案要改'],
  [false, '草率了，重新算一遍'],
  [false, '体操队的资料'],
  [false, '操盘手记录'],
  [false, '除草机的说明书'],
  [false, '我靠这个脚本跑批'],
  [false, '这个方案靠谱吗'],
  [false, '你帮我看一下配置'],
  [false, '你能不能搜一下内网'],
  [false, '你就按这个草稿改'],
  [false, '这个接口调不通，帮我查查'],
  [false, '把这个 ppt 存成 pdf'],
  [false, '我今天真是蠢，忘了备份'],
  [false, '这段代码写得有点笨，但能跑'],
  [false, '客户那套系统很难用'],
  [false, '死锁了，看下日志'],
  [false, '这条链路是主备关系'],
  [false, '干活吧'],

  // ── 英文：确实在骂 ─────────────────────────────
  [true, 'fuck this tool'],
  [true, 'what the fuck is going on'],
  [true, 'this is bullshit'],
  [true, 'you are an idiot'],
  [true, 'this app is garbage'],
  [true, 'you useless piece of shit'],
  [true, 'stfu'],
  [true, 'go to hell'],
  [true, 'screw you'],
  [true, 'this thing is absolutely terrible'],

  // ── 英文：正常干活 ─────────────────────────────
  [false, 'please assess the classic dumbbell shipment'],
  [false, 'run the analysis on Dumbarton'],
  [false, 'shitake mushrooms recipe'],
  [false, 'the Fukushima report'],
  [false, 'order the cocktail menu'],
  [false, 'class assignment passed'],
  [false, 'can you fix the build for me'],
  [false, 'you can search the intranet'],
  [false, 'the build is broken, can you look'],
  [false, 'this tool is unusable without login'],
  [false, 'assemble the bass guitar'],
  [false, 'the password reset failed'],
  [false, 'you need to pass the assertion'],

  // ── 葡语：确实在骂 ─────────────────────────────
  [true, 'que merda de programa'],
  [true, 'caralho, nao funciona'],
  [true, 'vai tomar no cu'],
  [true, 'filho da puta'],
  [true, 'voce e um idiota'],
  [true, 'esse bot e um lixo'],
  [true, 'isso e uma porcaria'],
  [true, 'seu escroto'],

  // ── 葡语：正常 / 不该触发 ──────────────────────
  [false, 'quero uma cerveja'],
  [false, 'vamos comer agora'],
  [false, 'ela e lesbica'],
  [false, 'o saco esta cheio'],
  [false, 'voce pode me ajudar'],
  [false, 'a reputacao da empresa'],
  [false, 'houve uma disputa entre eles'],
  [false, 'preciso de um relatorio'],
  // ── 第二轮：专挑边界 ───────────────────────────
  [false, '我靠这个脚本跑批'],
  [false, '我靠墙站着'],
  [false, '这个方案靠谱吗'],
  [true,  '我靠，又超时了'],
  [true,  '我靠！'],
  [true,  '妈的，白花两小时'],
  [false, '这个接口有毛病，帮我查查'],
  [false, '设备有毛病要返厂'],
  [true,  '你是不是有毛病'],
  [false, '面神经麻痹的资料'],
  [false, '日志里有报错'],
  [false, '今日流量统计'],
  [true,  '我日，怎么又断了'],
  [false, '这批交换机是华三的'],
  [false, '把草稿箱清一下'],
  [false, '操作手册第三章'],
  [false, '我操作了一下就好了'],
  [true,  '我操，这也能崩'],
  [false, '双击操作即可'],
  [false, '这个字段是可选的'],
  [false, 'you should assess this'],
  [false, 'the class passed all checks'],
  [false, 'we need to bypass the check'],
  [true,  'you are useless'],
  [true,  'this model is pathetic'],
  [false, 'the model is terrible at math, any tips'],
  [false, 'analyse the massive dataset'],
  [false, 'esse relatorio esta pronto'],
  [true,  'voce e burro'],
  [false, 'o burro carregava a carga'],
  // ── 英文：确实在骂（含常见口语形态）──────────────
  [true,  "you're an idiot"],
  [true,  'fuck off'],
  [true,  'this ai is dumb as hell'],
  [true,  'you suck'],
  [true,  'damn it, again?'],
  [true,  'what a piece of crap'],
  [true,  'you are pathetic'],
  [true,  'this assistant is a joke'],
  [true,  'wtf man'],
  [true,  'this thing is absolute trash'],
  [true,  'screw this'],
  [true,  'you moron'],
  [true,  'sod off'],
  [true,  'you are clueless'],
  [true,  'this product is ridiculous'],
  [true,  'shut up and do it'],
  [true,  'you braindead bot'],
  [true,  'this bot is worthless'],

  // ── 英文：技术词汇，一个都不能中 ─────────────────
  [false, 'run the assessment first'],
  [false, 'assign the vlan to port 3'],
  [false, 'check the assembly output'],
  [false, 'the bass response is flat'],
  [false, 'define a new class here'],
  [false, 'the packet did not pass'],
  [false, 'set the passphrase'],
  [false, 'use a compass bearing'],
  [false, 'the assassin creed dataset'],
  [false, 'open the cockpit view'],
  [false, 'Emily Dickinson poems'],
  [false, 'prickly pear cactus'],
  [false, 'analyse the process log'],
  [false, 'the access list is wrong'],
  [false, 'can you assist me'],
  [false, 'jerky motion in the animation'],
  [false, 'the pump sucks air from the intake'],
  [false, 'the model is terrible at math, any tips'],
  [false, 'latency is horrible on that link, please check'],
  [false, 'we hit a hard limit, need a workaround'],
  [false, 'summarize this document for me'],
  [false, 'you should check the error log'],
  [false, 'can you help me debug this'],

  // ── 葡语：确实在骂 ─────────────────────────────
  [true,  'que porra é essa'],
  [true,  'vai à merda'],
  [true,  'seu babaca'],
  [true,  'isso é uma bosta'],
  [true,  'você é um imbecil'],
  [true,  'programa de merda'],
  [true,  'puta merda'],
  // 「que otário」无指向，可能在说第三方（que otário esse cliente），按既定原则不触发
  // ——与「我今天真是蠢」「what an idiot」一致，宁可漏不可误伤
  [false, 'que otário'],
  [true,  'esse app é péssimo'],
  [true,  'você é um inútil'],
  [true,  'cala a boca, seu cretino'],
  [true,  'isso é ridículo'],

  // ── 葡语：正常用语 ─────────────────────────────
  [false, 'preciso de um computador novo'],
  [false, 'qual é o assunto do relatório'],
  [false, 'o processo terminou com sucesso'],
  [false, 'a classe está definida no arquivo'],
  [false, 'me dá acesso ao servidor'],
  [false, 'passo a passo, por favor'],
  [false, 'a massa de dados é grande'],
  [false, 'isso é ótimo, obrigado'],
  [false, 'você pode me ajudar com isso'],
  [false, 'esse relatório está pronto'],
  [false, 'a droga é cara no mercado'],
  [false, 'o burro carregava a carga'],
  [false, 'análise de dados de rede'],
  [false, 'faça o backup do banco'],
  [false, 'a reputação da empresa importa'],
]

/**
 * 语料回归网：一条条真实句子，标注该不该触发。
 *
 * 单元测试管"某个词在不在表里"，这份管"整体范围合不合理"——改词表最容易的翻车方式
 * 不是漏，是顺手放宽某条规则、把一堆正常干活的话也圈进去。误伤一条就挂，并打印是哪条。
 */
describe('骂人检测：范围体检', () => {
  it('全语料零误伤、零漏判', () => {
    const fp: string[] = []   // 误伤：不该触发却触发了
    const fn: string[] = []   // 漏判：该触发却没触发
    for (const [want, s] of CORPUS) {
      const got = detectAbuse(s)
      if (!want && got) fp.push(`${s}   ← 命中「${got.term}」(${got.tier}/${got.lang})`)
      if (want && !got) fn.push(s)
    }
    console.log(`\n语料 ${CORPUS.length} 条：误伤 ${fp.length}，漏判 ${fn.length}`)
    if (fp.length) console.log('\n【误伤】不该触发却触发：\n  ' + fp.join('\n  '))
    if (fn.length) console.log('\n【漏判】该触发却没触发：\n  ' + fn.join('\n  '))
    expect(fp, '误伤（不该触发却触发）').toEqual([])
    expect(fn, '漏判（该触发却没触发）').toEqual([])
  })
})
