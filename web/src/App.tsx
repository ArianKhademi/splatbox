import { SessionControls } from './components/SessionControls'
import { useRoute } from './lib/router'
import { SessionProvider } from './lib/session'
import { AssetPage } from './pages/AssetPage'
import { BrowsePage } from './pages/BrowsePage'
import { DemoPage } from './pages/DemoPage'

export function App() {
  const route = useRoute()
  return (
    <SessionProvider>
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
          <SessionControls />
        </header>
        <main>{route.page === 'demo' ? <DemoPage id={route.id} /> : route.page === 'asset' ? <AssetPage id={route.id} /> : <BrowsePage />}</main>
      </div>
    </SessionProvider>
  )
}
