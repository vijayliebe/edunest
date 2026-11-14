import 'katex/dist/katex.min.css'
import './index.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { AuthGate } from './auth'
import Layout from './components/Layout'
import CoursePage from './pages/Course'
import Home from './pages/Home'
import NotFound from './pages/NotFound'
import SearchPage from './pages/Search'
import Settings from './pages/Settings'
import Watch from './pages/Watch'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthGate>
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Home />} />
          <Route path="course/:id" element={<CoursePage />} />
          <Route path="watch/:id" element={<Watch />} />
          <Route path="search" element={<SearchPage />} />
          <Route path="settings" element={<Settings />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </BrowserRouter>
    </AuthGate>
  </StrictMode>,
)
