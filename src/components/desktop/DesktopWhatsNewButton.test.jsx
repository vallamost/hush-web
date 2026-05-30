import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { DesktopWhatsNewButton } from './DesktopWhatsNewButton.jsx';
import { OPEN_WHATS_NEW_EVENT } from '@/lib/changeAnnouncements';

afterEach(() => cleanup());

describe('DesktopWhatsNewButton', () => {
  it('dispatches the open-whats-new event on click', () => {
    const handler = vi.fn();
    window.addEventListener(OPEN_WHATS_NEW_EVENT, handler);
    try {
      render(<DesktopWhatsNewButton />);
      fireEvent.click(screen.getByRole('button', { name: "What's new" }));
      expect(handler).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(OPEN_WHATS_NEW_EVENT, handler);
    }
  });
});
