// @vitest-environment jsdom
import { useRef, useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Overlay } from './Overlay';

function OverlayHarness() {
  const [open, setOpen] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      <button onClick={() => setOpen(true)}>Mở dialog</button>
      {open && (
        <Overlay
          backdropClassName="test-backdrop"
          panelClassName="test-panel"
          labelledBy="test-dialog-title"
          initialFocusRef={closeButtonRef}
          onClose={() => setOpen(false)}
        >
          <h2 id="test-dialog-title">Dialog test</h2>
          <button ref={closeButtonRef}>Đóng</button>
          <button>Hành động cuối</button>
        </Overlay>
      )}
    </>
  );
}

describe('Overlay', () => {
  it('locks the app, traps focus, closes with Escape, and restores focus', async () => {
    const user = userEvent.setup();
    const appRoot = document.createElement('div');
    appRoot.id = 'root';
    document.body.append(appRoot);
    render(<OverlayHarness />, { container: appRoot });

    const trigger = screen.getByRole('button', { name: 'Mở dialog' });
    await user.click(trigger);

    const closeButton = screen.getByRole('button', { name: 'Đóng' });
    const lastButton = screen.getByRole('button', { name: 'Hành động cuối' });
    expect(screen.getByRole('dialog', { name: 'Dialog test' })).toBeInTheDocument();
    expect(closeButton).toHaveFocus();
    expect(appRoot).toHaveAttribute('inert');
    expect(appRoot).toHaveAttribute('aria-hidden', 'true');
    expect(document.body).toHaveStyle({ overflow: 'hidden' });

    lastButton.focus();
    fireEvent.keyDown(lastButton, { key: 'Tab' });
    expect(closeButton).toHaveFocus();

    fireEvent.keyDown(closeButton, { key: 'Tab', shiftKey: true });
    expect(lastButton).toHaveFocus();

    fireEvent.keyDown(lastButton, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(appRoot).not.toHaveAttribute('inert');
    expect(appRoot).not.toHaveAttribute('aria-hidden');
    expect(document.body).not.toHaveStyle({ overflow: 'hidden' });
  });
});
