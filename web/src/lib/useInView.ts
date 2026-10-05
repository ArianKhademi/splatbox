import { useEffect, useRef, useState } from 'react'

/**
 * True once the element has come within `rootMargin` of the viewport, and it stays true after:
 * the grid uses it to hold back thumbnail requests until a card is about to be seen.
 */
export function useInView<T extends Element>(rootMargin = '200px') {
  const ref = useRef<T>(null)
  const [inView, setInView] = useState(false)
  useEffect(() => {
    const element = ref.current
    if (!element || inView) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setInView(true)
          observer.disconnect()
        }
      },
      { rootMargin },
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [inView, rootMargin])
  return [ref, inView] as const
}
