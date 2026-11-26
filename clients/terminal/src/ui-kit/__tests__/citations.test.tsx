import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Markdown } from '../Markdown';

afterEach(cleanup);
it('renders source titles with escaped punctuation as one safe clickable link', () => {
  render(<Markdown>{'[Python \\[Path\\]\\(guide\\) \\`read_text\\`](https://docs.python.org/3/library/pathlib.html)'}</Markdown>);
  const link = screen.getByRole('link', { name: 'Python [Path](guide) `read_text`' });
  expect(link.getAttribute('href')).toBe('https://docs.python.org/3/library/pathlib.html');
  expect(link.getAttribute('rel')).toContain('noopener');
});

it('renders fenced code blocks with language header and working Copy code button', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });

  render(<Markdown>{'```python\nprint("hello tina")\n```'}</Markdown>);
  expect(screen.getByText('python')).toBeTruthy();
  expect(screen.getByText('print("hello tina")')).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));
  expect(writeText).toHaveBeenCalledWith('print("hello tina")');
});
