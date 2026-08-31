import { useEffect, useRef, useState } from 'react'

/**
 * 用户骂人时，从屏幕深处朝用户脸上扔💩。
 *
 * 观感靠两件事叠出来：从屏幕中心朝四面八方**放射状飞出**，同时**由小到大急剧放大**，
 * 缓动用 ease-in（先慢后快）——三者合起来才像"迎面砸过来"，少一样都会变成"平面上散开"。
 *
 * 纯覆盖层：fixed + pointer-events:none，不拦点击、不进布局，挂哪都行。
 * 每次 `trigger` 递增放一波，落完自行清掉，不留 DOM、不留定时器。
 *
 * 尊重 prefers-reduced-motion：系统关了动效就整波跳过——这种冲向面部的放大动画正是
 * 该关的那一类，对前庭敏感的人不友好。
 */

// 数量和放大倍数都刻意压着：这是个玩笑，不是惩罚。用户本来就在气头上，糊一脸
// 反而火上浇油——够意思到"看得出在开玩笑"就行，再多就是冒犯。
const PER_BURST = 7
const MAX_MS = 2000   // 单颗最慢的飞行时长，用它决定整波什么时候清理

interface Splat {
  id: string
  dx: number      // vw，飞出方向
  dy: number      // vh
  scale: number   // 终点放大倍数
  delay: number   // s
  duration: number
  spin: number    // deg
  base: number    // px，起始字号
}

function makeBurst(seed: number): Splat[] {
  return Array.from({ length: PER_BURST }, (_, i) => {
    // 角度均分再加抖动：纯随机会结块，留出大片空白，看着不像"一片砸过来"
    const angle = (i / PER_BURST) * Math.PI * 2 + (Math.random() - 0.5) * 0.5
    const reach = 60 + Math.random() * 45
    return {
      id: `${seed}-${i}`,
      dx: Math.cos(angle) * reach,
      dy: Math.sin(angle) * reach * 0.75,   // 竖直方向压一点，屏幕本来就是横的
      scale: 5 + Math.random() * 4,
      delay: Math.random() * 0.3,
      duration: 1.1 + Math.random() * 0.5,
      spin: (Math.random() * 2 - 1) * 240,
      base: 12 + Math.random() * 5,
    }
  })
}

export function PoopRain({ trigger }: { trigger: number }) {
  const [splats, setSplats] = useState<Splat[]>([])
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!trigger) return
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return

    setSplats(prev => [...prev, ...makeBurst(trigger)])
    // 飞完清空。多波叠加时以最后一波为准——中间那些多留一会儿看不出来，
    // 但能省掉「按波各自计时」那一堆状态。
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setSplats([]), MAX_MS + 400)
    return () => { if (timerRef.current) clearTimeout(timerRef.current) }
  }, [trigger])

  if (!splats.length) return null

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 overflow-hidden"
      style={{ zIndex: 9999 }}
    >
      {splats.map(s => (
        <span
          key={s.id}
          style={{
            position: 'absolute',
            left: '50%',
            top: '50%',
            fontSize: s.base,
            lineHeight: 1,
            willChange: 'transform, opacity',
            animation: `poop-throw ${s.duration}s cubic-bezier(.5,.02,.75,.3) ${s.delay}s both`,
            ['--poop-dx' as string]: `${s.dx}vw`,
            ['--poop-dy' as string]: `${s.dy}vh`,
            ['--poop-scale' as string]: `${s.scale}`,
            ['--poop-spin' as string]: `${s.spin}deg`,
          }}
        >
          💩
        </span>
      ))}
    </div>
  )
}
