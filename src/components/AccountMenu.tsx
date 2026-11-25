import { useEffect, useRef, useState } from 'react'
import Modal from './Modal'

export type Theme = 'default' | 'retro'

interface AccountMenuProps {
  theme: Theme
  onThemeChange: (theme: Theme) => void
  onSignOut?: () => void
}

function AccountMenu({ theme, onThemeChange, onSignOut }: AccountMenuProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [isAppearanceOpen, setIsAppearanceOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!isOpen) return

    function closeFromOutside(event: PointerEvent) {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) {
        setIsOpen(false)
      }
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setIsOpen(false)
        triggerRef.current?.focus()
      }
    }

    document.addEventListener('pointerdown', closeFromOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeFromOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [isOpen])

  function closeAppearance() {
    setIsAppearanceOpen(false)
    triggerRef.current?.focus()
  }

  return (
    <div className="account-menu" ref={menuRef}>
      <button
        aria-controls={isOpen ? 'discussit-account-menu' : undefined}
        aria-expanded={isOpen}
        aria-haspopup="menu"
        className="account-menu-trigger"
        onClick={() => setIsOpen((open) => !open)}
        ref={triggerRef}
        type="button"
      >
        <span>Account</span>
        <svg className="account-menu-chevron" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="m4 6 4 4 4-4" />
        </svg>
      </button>
      {isOpen && (
        <div
          className="account-menu-panel"
          id="discussit-account-menu"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setIsOpen(false)
              triggerRef.current?.focus()
              return
            }
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return

            const items = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
            )
            if (items.length === 0) return
            event.preventDefault()
            const activeIndex = items.findIndex((item) => item === document.activeElement)
            const direction = event.key === 'ArrowDown' ? 1 : -1
            const nextIndex =
              activeIndex < 0
                ? 0
                : (activeIndex + direction + items.length) % items.length
            items[nextIndex]?.focus()
          }}
          role="menu"
        >
          <button
            onClick={() => {
              setIsOpen(false)
              setIsAppearanceOpen(true)
            }}
            role="menuitem"
            type="button"
          >
            Appearance
          </button>
          {onSignOut && (
            <button
              onClick={() => {
                setIsOpen(false)
                onSignOut()
              }}
              role="menuitem"
              type="button"
            >
              Sign out
            </button>
          )}
        </div>
      )}
      {isAppearanceOpen && (
        <Modal className="appearance-modal" onClose={closeAppearance} title="Appearance">
          <div className="appearance-content">
            <p className="appearance-copy">Choose the DiscussIt theme for this browser.</p>
            <label className="appearance-label" htmlFor="discussit-theme">Theme</label>
            <select
              id="discussit-theme"
              onChange={(event) => {
                const value = event.currentTarget.value
                if (value === 'default' || value === 'retro') onThemeChange(value)
              }}
              value={theme}
            >
              <option value="default">Blue &amp; Cream</option>
              <option value="retro">Retro Blue</option>
            </select>
            <div className="modal-actions modal-actions-end">
              <button className="primary-button" onClick={closeAppearance} type="button">
                Done
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}

export default AccountMenu
