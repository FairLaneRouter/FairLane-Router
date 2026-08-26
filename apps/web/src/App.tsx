import { useState } from 'react'
import Board from './views/Board'
import Method from './views/Method'
import Rent from './views/Rent'
import SideBySide from './views/SideBySide'

type ViewKey = 'board' | 'side' | 'rent' | 'method'

const VIEWS: { key: ViewKey; label: string }[] = [
  { key: 'board', label: 'Board' },
  { key: 'side', label: 'Side by side' },
  { key: 'rent', label: 'Who pays the rent' },
  { key: 'method', label: 'Method' },
]

const App = () => {
  const [view, setView] = useState<ViewKey>('board')

  return (
    <div className="graph-paper min-h-screen">
      <div className="mx-auto max-w-[1120px] px-4 pb-24 pt-6 sm:px-8">
        <header className="border-b border-[hsl(var(--ink))] pb-3">
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <h1 className="u-caps text-[15px] font-semibold">Landing cost board</h1>
            <p className="u-label text-[13px] text-[hsl(var(--ink-muted))]">
              what it costs to get a Solana transaction into a block, by delivery service, against
              one reference
            </p>
          </div>

          <nav className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2">
            {VIEWS.map((v) => (
              <button
                key={v.key}
                type="button"
                onClick={() => setView(v.key)}
                className={`u-caps text-[10px] ${
                  view === v.key
                    ? 'text-[hsl(var(--ink))] underline underline-offset-[6px]'
                    : 'text-[hsl(var(--ink-muted))] hover:text-[hsl(var(--ink))]'
                }`}
              >
                {v.label}
              </button>
            ))}
          </nav>
        </header>

        <main className="pt-7">
          {view === 'board' && <Board />}
          {view === 'side' && <SideBySide />}
          {view === 'rent' && <Rent />}
          {view === 'method' && <Method />}
        </main>
      </div>
    </div>
  )
}

export default App
