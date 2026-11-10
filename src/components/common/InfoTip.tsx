import { Button, Column, Icon, Popover, Text } from '@umami/react-zen';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { useMessages } from '@/components/hooks';
import { Info } from '@/components/icons';

/**
 * A small (i) button with an explanation, so reports can keep definitions and
 * caveats out of the page body. It opens on mouse hover and on click or tap
 * (which pins it open), so it also works on phones and tablets, where a
 * hover-only tooltip can't be opened. Tap or click outside, or Esc, closes it.
 * `content` may be a string or several paragraphs.
 */
export function InfoTip({
  content,
  label,
  children,
  strong,
}: {
  content: ReactNode | ReactNode[];
  /** Accessible name when there is no visible text (defaults to "More information"). */
  label?: string;
  /** Optional visible text next to the icon (e.g. a short chip label). */
  children?: ReactNode;
  /** Show the visible text as a bold value (e.g. a table cell) instead of a muted label. */
  strong?: boolean;
}) {
  const { formatMessage, labels } = useMessages();
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  // react-zen's Button doesn't forward refs, so the popover anchors on a wrapper.
  const triggerRef = useRef<HTMLSpanElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const paragraphs = Array.isArray(content) ? content.filter(Boolean) : [content];

  const close = () => {
    setOpen(false);
    setPinned(false);
  };

  // Non-modal popovers aren't dismissed by react-aria on outside interaction,
  // so close on a pointer down outside the trigger and the content, or on Esc.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || contentRef.current?.contains(target)) return;
      close();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <>
      <span ref={triggerRef} style={{ display: 'inline-flex' }}>
        <Button
          variant="quiet"
          size="xs"
          // Visible text names the button; the icon-only version needs a label.
          aria-label={children ? undefined : (label ?? formatMessage(labels.moreInformation))}
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          style={{ minWidth: 0 }}
          // onHoverStart/End only fire for mouse and pen, never for touch.
          onHoverStart={() => setOpen(true)}
          onHoverEnd={() => {
            if (!pinned) setOpen(false);
          }}
          onPress={() => {
            // Click while hover-opened pins it; a second click (or a tap when
            // already pinned) closes it.
            if (open && pinned) close();
            else {
              setOpen(true);
              setPinned(true);
            }
          }}
        >
          {children &&
            (strong ? (
              <Text
                weight="bold"
                style={{ textDecoration: 'underline dotted', textUnderlineOffset: 3 }}
              >
                {children}
              </Text>
            ) : (
              <Text size="1" color="muted">
                {children}
              </Text>
            ))}
          {!strong && (
            <Icon size="xs" color="muted">
              <Info />
            </Icon>
          )}
        </Button>
      </span>
      <Popover
        triggerRef={triggerRef}
        isOpen={open}
        onOpenChange={isOpen => !isOpen && close()}
        isNonModal
        placement="top"
        style={{ maxWidth: 380 }}
      >
        <div ref={contentRef} id={id} role="note">
          <Column gap="2" padding="3" border borderRadius="3" backgroundColor shadow="3">
            {paragraphs.map((p, i) =>
              typeof p === 'string' ? (
                <Text key={i} size="1">
                  {p}
                </Text>
              ) : (
                <div key={i}>{p}</div>
              ),
            )}
          </Column>
        </div>
      </Popover>
    </>
  );
}
