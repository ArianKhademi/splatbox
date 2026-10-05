import { AuthGate } from './components/AuthGate'
import { useRoute } from './lib/router'
import { AssetPage } from './pages/AssetPage'
import { BrowsePage } from './pages/BrowsePage'
import { DemoPage } from './pages/DemoPage'

export function App() {
  const route = useRoute()
  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="#/">
          Splatbox
        </a>
        <nav>
          <a href="#/" aria-current={route.page !== 'demo'}>
            Browse
          </a>
          <a href="#/demo" aria-current={route.page === 'demo'}>
            Demo assets
          </a>
        </nav>
      </header>
      <main>
        {route.page === 'demo' ? (
          <DemoPage id={route.id} />
        ) : (
          <AuthGate>{route.page === 'asset' ? <AssetPage id={route.id} /> : <BrowsePage />}</AuthGate>
        )}
      </main>
    </div>
  )
}
