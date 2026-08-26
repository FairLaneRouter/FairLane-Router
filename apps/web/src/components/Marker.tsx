interface MarkerProps {
  children?: string
  className?: string
}

/**
 * Hairline-boxed caption. Sits next to every block of figures so a screenshot
 * of any single part of the screen carries the label with it.
 */
const Marker = ({ children = 'SYNTHETIC', className = '' }: MarkerProps) => (
  <span
    className={`u-caps inline-block border border-[hsl(var(--rule))] px-[5px] py-[1px] text-[9px] leading-[13px] text-[hsl(var(--ink-muted))] align-middle ${className}`}
  >
    {children}
  </span>
)

export default Marker
