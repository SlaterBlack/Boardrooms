import { useEffect, useState } from 'react'
import './App.css'

type ApiStatus = 'checking' | 'connected' | 'disconnected'

function App() {
  const [apiStatus, setApiStatus] = useState<ApiStatus>('checking')

  useEffect(() => {
    const controller = new AbortController()

    async function checkApi() {
      try {
        const response = await fetch('/api/health', {
          signal: controller.signal,
        })

        if (!response.ok) {
          throw new Error(`API returned ${response.status}`)
        }

        setApiStatus('connected')
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return
        }

        setApiStatus('disconnected')
      }
    }

    void checkApi()
    return () => controller.abort()
  }, [])

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="BoardMeetings home">
          <span className="brand-mark" aria-hidden="true">
            B
          </span>
          <span>boardmeetings</span>
        </a>
        <div className="workspace-label">
          <span className="workspace-dot" />
          Board workspace
        </div>
      </header>

      <section className="welcome">
        <p className="eyebrow">THE BOARDROOM, IN SYNC</p>
        <h1>Good decisions start with a clear view.</h1>
        <p className="intro">
          Your space for preparing meetings, sharing materials, and keeping
          decisions moving.
        </p>
      </section>

      <section className="overview" aria-label="Workspace overview">
        <article className="overview-card meetings-card">
          <div className="card-heading">
            <span className="card-icon calendar-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none">
                <rect x="3.75" y="5.75" width="16.5" height="14.5" rx="2.25" />
                <path d="M8 3.75v4M16 3.75v4M4 10h16" />
              </svg>
            </span>
            <span className="card-kicker">MEETINGS</span>
          </div>
          <h2>Your meeting space</h2>
          <p>
            Meeting schedules and materials will have a home here. Start by
            connecting your first meeting workflow.
          </p>
          <div className="card-footer">
            <span>Ready when you are</span>
            <span className="arrow" aria-hidden="true">
              ↗
            </span>
          </div>
        </article>

        <article className="overview-card decisions-card">
          <div className="card-heading">
            <span className="card-icon notes-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none">
                <path d="M7 3.75h7.5L19 8.25v12H7a2 2 0 0 1-2-2v-12a2.5 2.5 0 0 1 2-2.5Z" />
                <path d="M14 4v5h5M9 13h6M9 16.5h6" />
              </svg>
            </span>
            <span className="card-kicker">DECISIONS &amp; ACTIONS</span>
          </div>
          <h2>Keep outcomes in focus</h2>
          <p>
            Capture decisions and follow-ups alongside the conversations that
            created them.
          </p>
          <div className="card-footer">
            <span>Built for follow-through</span>
            <span className="arrow" aria-hidden="true">
              ↗
            </span>
          </div>
        </article>
      </section>

      <footer className="status-bar">
        <span
          className={`status-indicator ${apiStatus}`}
          aria-hidden="true"
        />
        <span>
          {apiStatus === 'checking' && 'Connecting to the API…'}
          {apiStatus === 'connected' && 'All systems connected'}
          {apiStatus === 'disconnected' && 'API unavailable — start the server to connect'}
        </span>
        <span className="status-divider" />
        <span className="status-note">A thoughtful space for better boards.</span>
      </footer>
    </main>
  )
}

export default App
