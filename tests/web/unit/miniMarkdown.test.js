import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/preact'
import { render } from 'preact'
import { html } from 'htm/preact'
import { renderMarkdown } from '../../../internal/web/static/app/miniMarkdown.js'

let container
function mount(source) {
  container = document.createElement('div')
  document.body.appendChild(container)
  render(html`<div>${renderMarkdown(source)}</div>`, container)
  return container
}

afterEach(() => {
  if (container) { render(null, container); container.remove(); container = null }
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('miniMarkdown conversation constructs', () => {
  it('renders GFM tables with alignment, escaped pipes, and pipes inside code', () => {
    const c = mount('| Name | Value | Note |\n| :--- | :---: | ---: |\n| A \\| B | `x|y` | **safe** |\n| second | 2 | done |')
    expect(c.querySelectorAll('thead th')).toHaveLength(3)
    expect(c.querySelectorAll('tbody tr')).toHaveLength(2)
    expect(c.querySelector('tbody td').textContent).toBe('A | B')
    expect(c.querySelector('tbody code').textContent).toBe('x|y')
    expect(c.querySelector('tbody strong').textContent).toBe('safe')
    expect(c.querySelectorAll('th')[0].style.textAlign).toBe('left')
    expect(c.querySelectorAll('th')[1].style.textAlign).toBe('center')
    expect(c.querySelectorAll('th')[2].style.textAlign).toBe('right')
    expect(c.querySelector('.markdown-table-scroll')).not.toBeNull()
  })

  it('renders nested ordered and unordered lists', () => {
    const c = mount('- parent\n  - child\n    1. grandchild\n- sibling\n\n1. first\n   1. nested ordered\n2. second')
    const top = c.querySelector(':scope > div > ul')
    expect(top.querySelector(':scope > li > ul > li > ol > li').textContent).toBe('grandchild')
    expect([...top.children].filter(el => el.tagName === 'LI')).toHaveLength(2)
    const ordered = c.querySelector(':scope > div > ol')
    expect(ordered.querySelector(':scope > li > ol > li').textContent).toBe('nested ordered')
    expect([...ordered.children].filter(el => el.tagName === 'LI')).toHaveLength(2)
  })

  it('renders headings, nested blockquotes, inline code, links, and horizontal rules', () => {
    const c = mount('# One\n## Two\n### Three\n#### Four\n##### Five\n###### Six\n\n> quoted **text**\n> > nested quote\n> - quoted item\n\nUse `1 < 2` and [safe](https://example.test/a).\n\n---')
    expect([...c.querySelectorAll('h3,h4,h5,h6')].map(el => el.textContent)).toEqual(['One', 'Two', 'Three', 'Four', 'Five', 'Six'])
    expect(c.querySelector('blockquote blockquote').textContent).toBe('nested quote')
    expect(c.querySelector('blockquote li').textContent).toBe('quoted item')
    expect(c.querySelector('p code').textContent).toBe('1 < 2')
    expect(c.querySelector('p a').getAttribute('href')).toBe('https://example.test/a')
    expect(c.querySelector('p a').getAttribute('rel')).toContain('noreferrer')
    expect(c.querySelector('hr')).not.toBeNull()
  })

  it('copies fenced code and preserves its language without interpreting HTML', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const c = mount('```html\n<img src=x onerror=alert(1)>\n  indented\n```')
    expect(c.querySelector('pre code').textContent).toBe('<img src=x onerror=alert(1)>\n  indented')
    expect(c.querySelector('pre code').className).toContain('language-html')
    expect(c.querySelector('img')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('<img src=x onerror=alert(1)>\n  indented'))
    await screen.findByText('Copied')
  })

  it('keeps malicious markup and unsafe URLs as inert text in every block context', () => {
    const c = mount('<script>alert(1)</script>\n\n> <img src=x onerror=alert(1)>\n\n| HTML | Link |\n| --- | --- |\n| <svg onload=alert(1)> | [bad](javascript:alert(1)) |\n\n~~~xml\n<iframe srcdoc="<script>alert(1)</script>"></iframe>\n~~~')
    expect(c.querySelector('script,img,svg,iframe')).toBeNull()
    expect(c.querySelector('a')).toBeNull()
    expect(c.textContent).toContain('<script>alert(1)</script>')
    expect(c.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(c.textContent).toContain('<svg onload=alert(1)>')
    expect(c.textContent).toContain('[bad](javascript:alert(1))')
    expect(c.textContent).toContain('<iframe srcdoc="<script>alert(1)</script>"></iframe>')
  })
})

describe('miniMarkdown links', () => {
  it('links bare and angle-bracket URLs without swallowing trailing punctuation', () => {
    const c = mount('Open https://example.com/a?b=1. Or <https://example.org/x>, then done')
    const links = [...c.querySelectorAll('a')]
    expect(links.map(a => a.getAttribute('href'))).toEqual(['https://example.com/a?b=1', 'https://example.org/x'])
    expect(links.every(a => a.target === '_blank' && a.rel === 'noopener noreferrer')).toBe(true)
    expect(c.textContent).toBe('Open https://example.com/a?b=1. Or https://example.org/x, then done')
  })

  it('links URLs inside bold text but not inside code', () => {
    const c = mount('**see https://example.com/p** and `https://example.com/code`')
    expect(c.querySelector('strong a').getAttribute('href')).toBe('https://example.com/p')
    expect(c.querySelector('code a')).toBeNull()
  })

  it('does not link non-http schemes', () => {
    const c = mount('javascript:alert(1) and [x](javascript:alert(1))')
    expect(c.querySelector('a')).toBeNull()
  })
})
