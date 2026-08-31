import { describe, expect, it } from 'vitest'
import { detectAbuse } from './profanity'

const hits = (s: string) => detectAbuse(s) !== null

describe('detectAbuse', () => {
  it('中文强脏话：单字、妈系、傻系、拼音缩写都认', () => {
    for (const s of [
      '操', '我操', '草', '我草', '艹', '卧槽', '靠北',
      '你他妈', '你妈的', '尼玛', '泥马', '草泥马', '特么', 'tmd', 'nmsl', 'cnm', 'mmp',
      '傻逼', '傻B', '沙比', '煞笔', '二逼', '傻叉',
      '王八蛋', '混蛋', '畜生', '杂种', '狗娘养的', '狗东西', '狗屎',
      '脑残', '智障', '弱智', '白痴', '神经病', '有病吧',
      '妈的，白等半天', '我日，怎么又断了', '我靠，又超时了',
      '滚蛋', '给我滚', '去死', '该死', '去你的',
    ]) {
      expect(hits(s), `应命中：${s}`).toBe(true)
    }
  })

  it('中文单字脏话不能误伤同形词——本产品里「操作」「草稿」满天飞', () => {
    for (const s of [
      '这个操作怎么做', '帮我操作一下', '别操心', '体操队', '操盘手', '操控台', '操场',
      '先写个草稿', '草图发我', '这份草案', '除草机', '水草缸', '太草率了', '草莓蛋糕',
    ]) {
      expect(hits(s), `不该命中：${s}`).toBe(false)
    }
  })

  it('英文强脏话与常见变体', () => {
    for (const s of [
      'fuck this', 'what the fuck', 'motherfucker', 'wtf', 'stfu', 'f*ck it',
      'this is bullshit', 'sh1t', 'you bitch', 'asshole', 'dumbass',
      'goddamn it', 'piss off', 'screw you', 'go to hell', 'what a crap',
    ]) {
      expect(hits(s), `应命中：${s}`).toBe(true)
    }
  })

  it('英文词边界：不误伤含子串的正常词', () => {
    for (const s of [
      'please assess the classic dumbbell shipment',
      'run the analysis on Dumbarton',
      'shitake mushrooms',
      'the cocktail menu',
      'class assignment passed',
    ]) {
      expect(hits(s), `不该命中：${s}`).toBe(false)
    }
  })

  it('葡语强脏话', () => {
    for (const s of [
      'que merda', 'caralho', 'vai tomar no cu', 'filho da puta', 'fdp',
      'vai se foder', 'que porra e essa', 'seu escroto', 'desgracado',
    ]) {
      expect(hits(s), `应命中：${s}`).toBe(true)
    }
  })

  it('葡语不收身份词与中性词——照抄公开清单会误伤且冒犯', () => {
    for (const s of [
      'quero uma cerveja',        // 啤酒
      'vamos comer agora',        // 吃饭
      'ela e lesbica',            // 身份词
      'o saco esta cheio',        // 袋子
    ]) {
      expect(hits(s), `不该命中：${s}`).toBe(false)
    }
  })

  it('贬义词必须指向我们才算', () => {
    // 骂我们 → 命中
    expect(detectAbuse('你这软件真垃圾')?.tier).toBe('soft')
    expect(detectAbuse('你这个笨蛋')?.tier).toBe('soft')
    expect(detectAbuse('你真没用')?.tier).toBe('soft')
    expect(detectAbuse('你是不是有毛病')?.tier).toBe('soft')
    expect(detectAbuse('this tool is garbage')?.tier).toBe('soft')
    expect(detectAbuse('you are useless')?.tier).toBe('soft')
    expect(detectAbuse('voce e um idiota')?.tier).toBe('soft')
    expect(detectAbuse('esse bot e um lixo')?.tier).toBe('soft')
    // 骂自己 / 骂第三方 → 不该触发
    expect(hits('我今天真是蠢')).toBe(false)
    expect(hits('这段代码写得很 stupid，我改改')).toBe(false)
    expect(hits('客户说他们那套系统很 terrible')).toBe(false)
    // 「有毛病」在本产品里多半是说设备/接口有故障，不带指向就不算骂
    expect(hits('这个接口有毛病，帮我查查')).toBe(false)
    expect(hits('我靠这个脚本跑批')).toBe(false)
  })

  it('日常请求一概不触发', () => {
    for (const s of [
      '', '   ',
      '帮我把这个 ppt 存成 pdf',
      '你帮我看一下这个配置',
      '你能不能搜一下内网',
      'you can search the intranet for me',
      'can you fix the build for me',
      'voce pode me ajudar',
      '这个方案你觉得行不行',
      '你就按这个草稿改',
    ]) {
      expect(hits(s), `不该命中：${JSON.stringify(s)}`).toBe(false)
    }
  })

  it('返回命中的原文片段，供上报备注使用', () => {
    expect(detectAbuse('这什么垃圾东西')?.term).toBe('垃圾')
    expect(detectAbuse('this tool is garbage')?.term).toBe('garbage')
    expect(detectAbuse('你他妈的')?.lang).toBe('zh')
  })
})
