import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom';
import { BookingPage } from './BookingPage';
import { HostDashboard } from './HostDashboard';
import { ManagePage } from './ManagePage';
import './styles.css';

function Home() {
  return (
    <main>
      <h1>Slotbook</h1>
      <p>Hosts publish when they are free; guests book a slot; nobody is double-booked.</p>
      <ul>
        <li><Link to="/demo/intro-call">Book an intro call</Link> (one-on-one, 30 min)</li>
        <li><Link to="/demo/group-workshop">Join a group workshop</Link> (up to 5 people, 60 min)</li>
        <li><Link to="/host">Host dashboard</Link> (login: demo / demo1234)</li>
      </ul>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/host" element={<HostDashboard />} />
        <Route path="/manage/:token" element={<ManagePage />} />
        <Route path="/:host/:slug" element={<BookingPage />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
