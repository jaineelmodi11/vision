// Text that arrives a word at a time, out of focus into focus. Pure CSS, so it
// plays the same whether or not anything else on the page is animating.

export function BlurWords({
  text,
  delay = 0,
  step = 38,
  className,
}: {
  text: string;
  /** ms before the first word. */
  delay?: number;
  /** ms between words. */
  step?: number;
  className?: string;
}) {
  const words = text.split(/\s+/).filter(Boolean);

  return (
    <span className={className}>
      {/* Read once, as a sentence. An aria-label on a bare span is not allowed
          and is ignored by some screen readers, which then read nothing. */}
      <span className="sr-only">{text}</span>
      {words.map((word, i) => (
        <span key={i} aria-hidden>
          <span className="blur-word" style={{ animationDelay: `${delay + i * step}ms` }}>
            {word}
          </span>
          {i < words.length - 1 && " "}
        </span>
      ))}
    </span>
  );
}
