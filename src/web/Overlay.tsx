import { createElement, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

let openOverlayCount = 0;
let previousBodyOverflow = '';
let previousAppInert = false;
let previousAppAriaHidden: string | null = null;

function getFocusableElements(panel: HTMLElement): HTMLElement[] {
  return [...panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter((element) => {
    const style = window.getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && element.getAttribute('aria-hidden') !== 'true';
  });
}

function lockApplication(): void {
  const appRoot = document.getElementById('root');
  if (openOverlayCount === 0) {
    previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    if (appRoot) {
      previousAppInert = appRoot.hasAttribute('inert');
      previousAppAriaHidden = appRoot.getAttribute('aria-hidden');
      appRoot.setAttribute('inert', '');
      appRoot.setAttribute('aria-hidden', 'true');
    }
  }
  openOverlayCount++;
}

function unlockApplication(): void {
  openOverlayCount = Math.max(0, openOverlayCount - 1);
  if (openOverlayCount > 0) return;

  const appRoot = document.getElementById('root');
  document.body.style.overflow = previousBodyOverflow;
  if (!appRoot) return;

  if (previousAppInert) appRoot.setAttribute('inert', '');
  else appRoot.removeAttribute('inert');
  if (previousAppAriaHidden === null) appRoot.removeAttribute('aria-hidden');
  else appRoot.setAttribute('aria-hidden', previousAppAriaHidden);
}

export interface OverlayProps {
  children: ReactNode;
  onClose(): void;
  backdropClassName: string;
  panelClassName: string;
  panelAs?: 'aside' | 'div' | 'section';
  ariaLabel?: string;
  labelledBy?: string;
  describedBy?: string;
  initialFocusRef?: RefObject<HTMLElement | null>;
  getRestoreFocusTarget?: () => HTMLElement | null;
  closeOnBackdrop?: boolean;
}

export function Overlay({
  children,
  onClose,
  backdropClassName,
  panelClassName,
  panelAs = 'section',
  ariaLabel,
  labelledBy,
  describedBy,
  initialFocusRef,
  getRestoreFocusTarget,
  closeOnBackdrop = true,
}: OverlayProps) {
  const panelRef = useRef<HTMLElement | null>(null);
  const getRestoreFocusTargetRef = useRef(getRestoreFocusTarget);
  getRestoreFocusTargetRef.current = getRestoreFocusTarget;

  useLayoutEffect(() => {
    const restoreFocusTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    if (!panel) return;

    const initialFocus = initialFocusRef?.current || getFocusableElements(panel)[0] || panel;
    initialFocus.focus();
    lockApplication();

    return () => {
      unlockApplication();
      const currentRestoreTarget = getRestoreFocusTargetRef.current?.();
      if (currentRestoreTarget?.isConnected) currentRestoreTarget.focus();
      else if (restoreFocusTo?.isConnected) restoreFocusTo.focus();
    };
  }, [initialFocusRef]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab' || !panelRef.current) return;

    const focusableElements = getFocusableElements(panelRef.current);
    if (focusableElements.length === 0) {
      event.preventDefault();
      panelRef.current.focus();
      return;
    }

    const firstElement = focusableElements[0];
    const lastElement = focusableElements[focusableElements.length - 1];
    if (event.shiftKey && document.activeElement === firstElement) {
      event.preventDefault();
      lastElement.focus();
    } else if (!event.shiftKey && document.activeElement === lastElement) {
      event.preventDefault();
      firstElement.focus();
    }
  };

  const panel = createElement(panelAs, {
    ref: panelRef,
    className: panelClassName,
    role: 'dialog',
    'aria-modal': true,
    'aria-label': ariaLabel,
    'aria-labelledby': labelledBy,
    'aria-describedby': describedBy,
    tabIndex: -1,
  }, children);

  return createPortal(
    <div
      className={backdropClassName}
      role="presentation"
      onKeyDown={handleKeyDown}
      onMouseDown={(event) => closeOnBackdrop && event.target === event.currentTarget && onClose()}
    >
      {panel}
    </div>,
    document.body,
  );
}
