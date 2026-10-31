const queryAll = (selector) => {
    const normalize = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()
    const pattern = (value) => (value !== null && typeof value === 'object' && typeof value.source === 'string' ? new RegExp(value.source, value.flags) : null)
    const matchText = (actual, expected, exact) => {
        const value = normalize(actual)
        const regex = pattern(expected)
        if (regex) return regex.test(value)
        const wanted = normalize(expected)
        return exact ? value === wanted : value.toLowerCase().includes(wanted.toLowerCase())
    }
    const CONTENT_ROLES = new Set(['button', 'cell', 'checkbox', 'columnheader', 'gridcell', 'heading', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'radio', 'row', 'rowheader', 'switch', 'tab', 'treeitem'])
    const isHidden = (element) => {
        for (let node = element; node; node = node.parentElement) {
            if (node.getAttribute('aria-hidden') === 'true') return true
        }
        const anchor = element.tagName === 'OPTION' && element.closest('select') ? element.closest('select') : element
        return typeof anchor.checkVisibility === 'function' ? !anchor.checkVisibility({ visibilityProperty: true }) : getComputedStyle(anchor).display === 'none'
    }
    const roleOf = (element) => {
        const explicit = normalize(element.getAttribute('role')).split(' ')[0].toLowerCase()
        if (explicit) return explicit
        const tag = element.tagName.toLowerCase()
        const type = (element.getAttribute('type') || '').toLowerCase()
        const named = element.hasAttribute('aria-label') || element.hasAttribute('aria-labelledby')
        if (tag === 'a' || tag === 'area') return element.hasAttribute('href') ? 'link' : ''
        if (tag === 'button') return 'button'
        if (tag === 'input') {
            if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button'
            if (type === 'checkbox') return 'checkbox'
            if (type === 'radio') return 'radio'
            if (type === 'range') return 'slider'
            if (type === 'number') return 'spinbutton'
            if (type === 'search') return element.hasAttribute('list') ? 'combobox' : 'searchbox'
            if (['', 'text', 'email', 'tel', 'url'].includes(type)) return element.hasAttribute('list') ? 'combobox' : 'textbox'
            return ''
        }
        if (tag === 'textarea') return 'textbox'
        if (tag === 'select') return element.multiple || element.size > 1 ? 'listbox' : 'combobox'
        if (tag === 'option') return 'option'
        if (tag === 'img') return element.getAttribute('alt') === '' ? 'presentation' : 'img'
        if (/^h[1-6]$/.test(tag)) return 'heading'
        if (tag === 'ul' || tag === 'ol' || tag === 'menu') return 'list'
        if (tag === 'li') return 'listitem'
        if (tag === 'nav') return 'navigation'
        if (tag === 'main') return 'main'
        if (tag === 'aside') return 'complementary'
        if (tag === 'article') return 'article'
        if (tag === 'header') return element.closest('article,aside,main,nav,section') ? '' : 'banner'
        if (tag === 'footer') return element.closest('article,aside,main,nav,section') ? '' : 'contentinfo'
        if (tag === 'section') return named ? 'region' : ''
        if (tag === 'form') return named ? 'form' : ''
        if (tag === 'table') return 'table'
        if (tag === 'tr') return 'row'
        if (tag === 'td') return 'cell'
        if (tag === 'th') return 'columnheader'
        if (tag === 'dialog') return 'dialog'
        if (tag === 'progress') return 'progressbar'
        if (tag === 'meter') return 'meter'
        if (tag === 'hr') return 'separator'
        if (tag === 'details') return 'group'
        return ''
    }
    const labelText = (element) =>
        Array.from(element.labels || [])
            .map((label) => normalize(label.textContent))
            .filter(Boolean)
            .join(' ')
    const idsText = (ids) => normalize(String(ids || '').split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' '))
    const contentText = (element) => normalize(element.textContent) || normalize(Array.from(element.querySelectorAll('img[alt]')).map((img) => img.getAttribute('alt')).join(' '))
    const nameOf = (element) => {
        const labelled = idsText(element.getAttribute('aria-labelledby'))
        if (labelled) return labelled
        const label = normalize(element.getAttribute('aria-label'))
        if (label) return label
        const tag = element.tagName.toLowerCase()
        const type = (element.getAttribute('type') || '').toLowerCase()
        if (tag === 'img' || (tag === 'input' && type === 'image')) return normalize(element.getAttribute('alt'))
        if (tag === 'input' && ['button', 'submit', 'reset'].includes(type)) {
            const fallback = type === 'submit' ? 'Submit' : type === 'reset' ? 'Reset' : ''
            return normalize(element.value) || fallback
        }
        if (tag === 'input' || tag === 'textarea' || tag === 'select') {
            return labelText(element) || normalize(element.getAttribute('title')) || normalize(element.getAttribute('placeholder'))
        }
        if (CONTENT_ROLES.has(roleOf(element))) return contentText(element)
        return normalize(element.getAttribute('title'))
    }
    const headingLevel = (element) => {
        const level = Number(element.getAttribute('aria-level'))
        if (level) return level
        const match = /^H([1-6])$/.exec(element.tagName)
        return match ? Number(match[1]) : undefined
    }
    const flag = (element, attribute) => element.getAttribute(attribute) === 'true'
    const isChecked = (element) => flag(element, 'aria-checked') || element.checked === true
    const isDisabled = (element) => element.disabled === true || flag(element, 'aria-disabled')
    const isSelected = (element) => element.selected === true || flag(element, 'aria-selected')
    const byAttribute = (scope, attribute, args) =>
        Array.from((scope || document).querySelectorAll(`[${attribute}]`)).filter((element) => matchText(element.getAttribute(attribute), args.text, args.exact === true))
    const engines = {
        role: (args, scope) =>
            Array.from((scope || document).querySelectorAll('*')).filter((element) => {
                if (!args.includeHidden && isHidden(element)) return false
                if (roleOf(element) !== normalize(args.role).toLowerCase()) return false
                if (args.name !== undefined && !matchText(nameOf(element), args.name, args.exact === true)) return false
                if (args.level !== undefined && headingLevel(element) !== args.level) return false
                if (args.checked !== undefined && isChecked(element) !== args.checked) return false
                if (args.disabled !== undefined && isDisabled(element) !== args.disabled) return false
                if (args.selected !== undefined && isSelected(element) !== args.selected) return false
                if (args.expanded !== undefined && flag(element, 'aria-expanded') !== args.expanded) return false
                if (args.pressed !== undefined && flag(element, 'aria-pressed') !== args.pressed) return false
                return true
            }),
        text: (args, scope) => {
            const root = scope || document.body || document.documentElement
            const matches = (element) => matchText(element.textContent, args.text, args.exact === true)
            return Array.from(root.querySelectorAll('*')).filter((element) => matches(element) && !Array.from(element.children).some(matches))
        },
        label: (args, scope) => {
            const root = scope || document
            const found = []
            const add = (element) => {
                if (element && !found.includes(element)) found.push(element)
            }
            for (const label of Array.from(root.querySelectorAll('label'))) {
                if (matchText(label.textContent, args.text, args.exact === true)) {
                    add(label.control || (label.htmlFor ? document.getElementById(label.htmlFor) : null) || label.querySelector('input,select,textarea'))
                }
            }
            for (const element of Array.from(root.querySelectorAll('[aria-label]'))) {
                if (matchText(element.getAttribute('aria-label'), args.text, args.exact === true)) add(element)
            }
            for (const element of Array.from(root.querySelectorAll('[aria-labelledby]'))) {
                if (matchText(idsText(element.getAttribute('aria-labelledby')), args.text, args.exact === true)) add(element)
            }
            return found.sort((left, right) => (left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
        },
        placeholder: (args, scope) => byAttribute(scope, 'placeholder', args),
        alt: (args, scope) => byAttribute(scope, 'alt', args),
        title: (args, scope) => byAttribute(scope, 'title', args),
        testid: (args, scope) => Array.from((scope || document).querySelectorAll(`[${args.attribute}]`)).filter((element) => element.getAttribute(args.attribute) === args.text)
    }
    const single = (part, scope) => {
        const internal = /^internal:([a-z-]+)=(.*)$/.exec(part)
        if (internal) return engines[internal[1]](JSON.parse(decodeURIComponent(internal[2])), scope)
        if (part.startsWith('xpath=') || part.startsWith('/') || part.startsWith('(/')) {
            const expression = part.startsWith('xpath=') ? part.slice(6) : part
            const snapshot = document.evaluate(expression, scope || document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null)
            const found = []
            for (let index = 0; index < snapshot.snapshotLength; index++) found.push(snapshot.snapshotItem(index))
            return found
        }
        if (part.startsWith('text=')) {
            const raw = part.slice(5).trim()
            const exact = raw.length > 1 && raw.startsWith('"') && raw.endsWith('"')
            return engines.text({ text: exact ? raw.slice(1, -1) : raw, exact }, scope)
        }
        return Array.from((scope || document).querySelectorAll(part.startsWith('css=') ? part.slice(4) : part))
    }
    let nodes = null
    for (const rawPart of selector.split(' >> ')) {
        const part = rawPart.trim()
        const nth = /^nth=(-?\d+)$/.exec(part)
        const hasText = /^internal:has-text=(.*)$/.exec(part)
        if (nth) {
            const list = nodes || []
            const value = Number(nth[1])
            const index = value < 0 ? list.length + value : value
            nodes = index >= 0 && index < list.length ? [list[index]] : []
        } else if (hasText) {
            const { text } = JSON.parse(decodeURIComponent(hasText[1]))
            nodes = (nodes || []).filter((element) => matchText(element.textContent, text, false))
        } else if (nodes === null) {
            nodes = single(part, null)
        } else {
            const next = new Set()
            for (const node of nodes) for (const found of single(part, node)) next.add(found)
            nodes = Array.from(next)
        }
    }
    return nodes || []
}

const domOp = (query, op, selector, arg) => {
    const nodes = query(selector)
    const node = nodes[0]
    const visible = (target) => {
        const rect = target.getBoundingClientRect()
        const style = getComputedStyle(target)
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
    }
    const enabled = (target) => !target.disabled && target.getAttribute('aria-disabled') !== 'true'
    const editable = (target) => target.isContentEditable || ((target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') && !target.readOnly && !target.disabled)
    const box = (target) => {
        const rect = target.getBoundingClientRect()
        return { left: rect.left, top: rect.top, width: rect.width, height: rect.height, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    }
    switch (op) {
        case 'count':
            return nodes.length
        case 'texts':
            return nodes.map((target) => target.textContent)
        case 'state':
            if (!node) return { attached: false }
            return { attached: true, visible: visible(node), enabled: enabled(node), editable: editable(node), checked: node.checked === true }
        case 'box':
            return node ? box(node) : null
        case 'reveal':
            if (!node) return null
            node.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
            return box(node)
        case 'focus':
            if (!node) return false
            node.focus()
            if (arg && arg.select) {
                if (typeof node.select === 'function') {
                    node.select()
                } else if (node.isContentEditable) {
                    const range = document.createRange()
                    range.selectNodeContents(node)
                    const selection = window.getSelection()
                    selection.removeAllRanges()
                    selection.addRange(range)
                }
            }
            return true
        case 'text':
            if (!node) return null
            if (arg.kind === 'attr') return node.getAttribute(arg.name)
            return node[arg.kind] ?? null
        case 'select': {
            if (!node) throw new Error(`Element not found: "${selector}"`)
            if (node.tagName !== 'SELECT') throw new Error('Element is not a <select> element')
            const values = arg || []
            const options = Array.from(node.options)
            for (const value of values) {
                if (!options.some((option) => option.value === value || option.label === value)) throw new Error(`Option not found: "${value}"`)
            }
            for (const option of options) {
                option.selected = values.includes(option.value) || values.includes(option.label)
            }
            node.dispatchEvent(new Event('input', { bubbles: true }))
            node.dispatchEvent(new Event('change', { bubbles: true }))
            return Array.from(node.selectedOptions).map((option) => option.value)
        }
        default:
            throw new Error(`Unsupported operation: ${op}`)
    }
}

export const QUERY_SOURCE = queryAll.toString()
export const DOM_SOURCE = domOp.toString()
