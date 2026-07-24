import React, { useState, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, Link, useLocation, useNavigate } from 'react-router-dom';
import './App.css';
import Logo from './Logo';
import { TagAlongWordmark } from './TagAlongLogo';
import { enableClickSound, isUiMuted, setUiMuted, armAudioUnlock } from './clickSound';
import { registerPush, resendPushToken } from './push';
import { has as hasFeature } from './product';
import AlertWatcher from './AlertWatcher';
import AlertDetailModal from './AlertDetailModal';
import DispatchAutomation from './DispatchAutomation';
import Autopilot from './autopilot';
import { autoGenerateIfNeeded } from './reportGenerator';

// Pages
import DashboardPage from './pages/DashboardPage';
import DriversPage from './pages/DriversPage';
import VehiclesPage from './pages/VehiclesPage';
import MapPage from './pages/MapPage';
import LoadsPage from './pages/LoadsPage';
import RoutesPage from './pages/RoutesPage';
import MaintenancePage from './pages/MaintenancePage';
import CompliancePage from './pages/CompliancePage';
import SafetyPage from './pages/SafetyPage';
import AnalyticsPage from './pages/AnalyticsPage';
import CamerasPage from './pages/CamerasPage';
import ReportsPage from './pages/ReportsPage';
import AlertsPage from './pages/AlertsPage';
import HealthPage from './pages/HealthPage';
import TrailersPage from './pages/TrailersPage';
import DispatchPage from './pages/DispatchPage';
import TripsPage from './pages/TripsPage';
import CarPage from './pages/CarPage';
import TripHistoryPage from './pages/TripHistoryPage';
import IntakePage from './pages/IntakePage';
import CustomersPage from './pages/CustomersPage';
import OrdersPage from './pages/OrdersPage';
import RentalsPage from './pages/RentalsPage';
import BrokerPage from './pages/BrokerPage';
import FamilyPage from './pages/FamilyPage';
import FleetPage from './pages/FleetPage';
import LoginPage from './pages/LoginPage';
import LegalPage from './LegalPages';
import ShopPage from './pages/ShopPage';
import ProductsPage from './pages/ProductsPage';
import AdminLoginPage from './pages/AdminLoginPage';
import SetPasswordPage from './pages/SetPasswordPage';
import { isLoggedIn, logout, isAdmin, logoutAdmin, getSession, getStoredMe, getDevices } from './traccar';
import { pendingLinks } from './brokerLink';
import { pendingMemberLinks } from './memberLink';
import { anyRentalEnabled } from './rentalStore';
import { newOrdersCount } from './ordersStore';

const API_URL = 'http://142.93.78.66:5050';

// Admin override: on the TagAlong domain, visiting with ?admin opens the Dynamic
// Dispatch admin app (still password-protected). We remember it for the tab via
// sessionStorage so in-app navigation/refresh stays in admin mode; it clears on
// admin sign-out. This lets us add a small "Admin" link on the customer login.
export const ADMIN_MODE = (() => {
  if (typeof window === 'undefined') return false;
  try {
    if (/[?&]admin\b/i.test(window.location.search)) { sessionStorage.setItem('ta-admin-mode', '1'); return true; }
    return sessionStorage.getItem('ta-admin-mode') === '1';
  } catch { return /[?&]admin\b/i.test(window.location.search); }
})();

// One app, two faces — decided at runtime by the domain. When the TagAlong
// domain (e.g. mytagalong.app / mytagalong.us) is used, the same deployment
// shows the consumer TagAlong experience; every other domain shows the full
// Dynamic Dispatch dashboard. (Add ?tagalong to the URL to preview it anywhere;
// add ?admin on the TagAlong domain to reach the admin sign-in.)
// TagAlong Fleet is the commercial sibling: same tracking core, but built around
// a company with many vehicles, drivers and staff logins rather than a family
// with a couple of cars. Which product this build is lives in ./product.js —
// see PRODUCT.features for what each one turns on.
export { PRODUCT, IS_FLEET, has as hasFeature } from './product';

// Both consumer TagAlong and TagAlong Fleet use the customer-facing shell (as
// opposed to the internal Dynamic Dispatch dashboard), so IS_TAGALONG stays the
// "is this a customer app?" switch and IS_FLEET distinguishes which one.
export const IS_TAGALONG = ((typeof window !== 'undefined' && (
  /tagalong|fleet/i.test(window.location.hostname)
  || /[?&](tagalong|fleet|pro)\b/i.test(window.location.search)
  || /^\/pro/i.test(window.location.pathname)
  || /(^|\.)pro\./i.test(window.location.hostname)
)) || process.env.REACT_APP_PRODUCT === 'tagalong'
  || process.env.REACT_APP_PRODUCT === 'fleet'
  || process.env.REACT_APP_PRODUCT === 'pro') && !ADMIN_MODE;

// True inside the native iOS/Android (Capacitor) app.
export const IS_NATIVE = typeof window !== 'undefined' && !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

// On localhost the TagAlong site is selected by the ?tagalong query param, so we
// must carry it on every in-app link — otherwise navigating to a bare path like
// /alerts drops it and a refresh/sign-out falls back to the admin app. (On the
// real tagalong domain this is empty and unneeded.) Captured once at load.
export const TAGALONG_QS = (typeof window !== 'undefined' && /[?&]tagalong\b/i.test(window.location.search))
  ? window.location.search
  : '';

// TagAlong (consumer) menu — the car-owner screens
const TAGALONG_MENU = [
  { name: 'Live Tracking', path: '/map', icon: '🗺️' },
  { name: 'TagAlong', path: '/car', icon: '🚗' },
  { name: 'Trip History', path: '/history', icon: '🗓️' },
  { name: 'Vehicles', path: '/vehicles', icon: '🚙' },
  { name: 'Rentals', path: '/rentals', icon: '🚗' },
  { name: 'Analytics', path: '/analytics', icon: '📈' },
  { name: 'Vehicle Health', path: '/health', icon: '🩺' },
  { name: 'Alerts', path: '/alerts', icon: '🔔' },
  { name: 'Shop', path: '/shop', icon: '🛒' },
];

const FULL_MENU = [
  { name: 'Device Intake', path: '/intake', icon: '📦' },
  { name: 'Orders', path: '/orders', icon: '🛒' },
  { name: 'Products', path: '/products', icon: '🏷️' },
  { name: 'Customers', path: '/customers', icon: '👥' },
  { name: 'Live Tracking', path: '/map', icon: '🗺️' },
  { name: 'TagAlong', path: '/car', icon: '🚗' },
  { name: 'Dispatch', path: '/dispatch', icon: '🚦' },
  { name: 'Trips', path: '/trips', icon: '🧭' },
  { name: 'Drivers', path: '/drivers', icon: '👤' },
  { name: 'Vehicles', path: '/vehicles', icon: '🚛' },
  { name: 'Rentals', path: '/rentals', icon: '🚗' },
  { name: 'Trailers', path: '/trailers', icon: '🚚' },
  { name: 'Analytics', path: '/analytics', icon: '📈' },
  { name: 'Vehicle Health', path: '/health', icon: '🩺' },
  { name: 'Dashboard', path: '/', icon: '📊' },
  { name: 'Loads', path: '/loads', icon: '📦' },
  { name: 'Routes', path: '/routes', icon: '🛣️' },
  { name: 'Maintenance', path: '/maintenance', icon: '🔧' },
  { name: 'Compliance', path: '/compliance', icon: '✅' },
  { name: 'Safety', path: '/safety', icon: '⚠️' },
  { name: 'Cameras', path: '/cameras', icon: '📹' },
  { name: 'Reports', path: '/reports', icon: '📄' },
  { name: 'Alerts', path: '/alerts', icon: '🔔' },
];

const DEFAULT_MENU = IS_TAGALONG ? TAGALONG_MENU : FULL_MENU;

const MENU_ORDER_KEY = IS_TAGALONG ? 'ta-menu-order' : 'dd-menu-order';

function loadMenuOrder() {
  try {
    const saved = JSON.parse(localStorage.getItem(MENU_ORDER_KEY));
    const byPath = Object.fromEntries(DEFAULT_MENU.map((m) => [m.path, m]));
    const savedPaths = Array.isArray(saved) ? saved : [];
    // items in the user's saved order that still exist
    const ordered = savedPaths.map((p) => byPath[p]).filter(Boolean);
    // insert any new/missing tab at its natural default position
    DEFAULT_MENU.forEach((m, i) => {
      if (!ordered.some((x) => x.path === m.path)) ordered.splice(Math.min(i, ordered.length), 0, m);
    });
    return ordered.length ? ordered : DEFAULT_MENU;
  } catch {
    return DEFAULT_MENU;
  }
}

function AppContent() {
  const [selectedVehicle, setSelectedVehicle] = useState(null);
  const location = useLocation();

  // TagAlong customers must sign in (they only see their own cars). ?admin now
  // opens the admin sign-in (via ADMIN_MODE above) rather than bypassing it, so
  // it's no longer a bypass. `as=` stays for internal preview/testing only.
  const bypassLogin = typeof window !== 'undefined' && /[?&]as=\b/i.test(window.location.search);
  const [authed, setAuthed] = useState(isLoggedIn());
  // Admin gate for the Dynamic Dispatch dashboard (non-TagAlong domains).
  const [adminAuthed, setAdminAuthed] = useState(isAdmin());
  // First-login password gate: a phone-created customer must set their own
  // password before using the app. pwUser holds their Traccar record when due.
  const [pwUser, setPwUser] = useState(null);
  useEffect(() => {
    if (!IS_TAGALONG || !authed || bypassLogin) { setPwUser(null); return; }
    let cancel = false;
    getSession().then((u) => { if (!cancel && u && u.attributes && u.attributes.mustSetPassword) setPwUser(u); }).catch(() => {});
    return () => { cancel = true; };
  }, [authed, bypassLogin]);

  // New-customer gate: a signed-in customer with NO cars (owned or shared) only
  // sees the Shop until they buy or a car is added. Admins are never gated.
  const navigate = useNavigate();
  const [custDeviceCount, setCustDeviceCount] = useState(null);
  useEffect(() => {
    if (!IS_TAGALONG || !authed || bypassLogin) { setCustDeviceCount(null); return undefined; }
    const meNow = getStoredMe();
    if (meNow && (meNow.administrator || meNow.admin)) { setCustDeviceCount(null); return undefined; }
    let cancel = false;
    const check = () => getDevices().then((d) => { if (!cancel) setCustDeviceCount(d.length); }).catch(() => {});
    check();
    const t = setInterval(check, 20000);
    return () => { cancel = true; clearInterval(t); };
  }, [authed, bypassLogin]);
  const shopOnly = IS_TAGALONG && custDeviceCount === 0; // device-less customer
  useEffect(() => {
    if (shopOnly && location.pathname !== '/shop') navigate(`/shop${TAGALONG_QS}`);
  }, [shopOnly, location.pathname, navigate]);

  const [menuItems, setMenuItems] = useState(loadMenuOrder);
  // hide the Rentals tab until a vehicle is marked as a rental
  const [rentalsOn, setRentalsOn] = useState(anyRentalEnabled());
  useEffect(() => {
    const tick = () => setRentalsOn(anyRentalEnabled());
    tick();
    const t = setInterval(tick, 4000);
    window.addEventListener('focus', tick);
    return () => { clearInterval(t); window.removeEventListener('focus', tick); };
  }, []);
  const [dragIndex, setDragIndex] = useState(null);
  const [navCollapsed, setNavCollapsed] = useState(false); // native: hide the top banner for a full-screen view

  // pending broker approval requests across the owner's cars → Vehicles badge
  const [brokerBadge, setBrokerBadge] = useState(0);
  useEffect(() => {
    let cancel = false;
    const tick = async () => {
      try { const devs = await getDevices(); if (!cancel) setBrokerBadge(devs.reduce((s, d) => s + pendingLinks(d).length + pendingMemberLinks(d).length, 0)); } catch { /* ignore */ }
    };
    tick();
    const t = setInterval(tick, 15000);
    return () => { cancel = true; clearInterval(t); };
  }, []);

  // live count of orders needing attention — drives the Orders tab badge
  const [orderBadge, setOrderBadge] = useState(newOrdersCount());
  useEffect(() => {
    const tick = () => setOrderBadge(newOrdersCount());
    const t = setInterval(tick, 4000);
    window.addEventListener('focus', tick);
    return () => { clearInterval(t); window.removeEventListener('focus', tick); };
  }, []);

  useEffect(() => { armAudioUnlock(); }, []); // unlock audio so alert sounds can play (no UI tap tick)
  // Native locked-phone push: register once the customer is signed in, and jump
  // to the right car when they tap a notification.
  // Tapping a push notification opens that alert's detail screen (map + device,
  // time, coordinates, speed, address) — same screen the Alerts history uses.
  const [pushAlert, setPushAlert] = useState(null);
  useEffect(() => {
    if (authed && IS_NATIVE && IS_TAGALONG) {
      registerPush((path, data) => {
        try {
          const d = data || {};
          if (d.alert && d.lat != null && d.lng != null) {
            setPushAlert({
              icon: '🔔',
              title: d.atitle || d.title || 'Alert',
              entity: d.car || '',
              place: {
                lat: Number(d.lat), lng: Number(d.lng),
                speed: d.spd != null ? Number(d.spd) : null,
                at: d.ts ? Number(d.ts) : Date.now(),
                imei: d.imei || '', device: d.car || '',
              },
            });
          }
          navigate(String(path).replace(/^\/?/, '/'));
        } catch { /* ignore */ }
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed]);
  // Re-send the push token every time the app comes back to the foreground, so
  // the backend always has the current token (iOS can rotate it while the app is
  // closed). Keeps locked / force-closed push delivery reliable over time.
  useEffect(() => {
    if (!(IS_NATIVE && IS_TAGALONG)) return undefined;
    let sub;
    (async () => {
      try {
        const { App: CapApp } = await import('@capacitor/app');
        sub = await CapApp.addListener('appStateChange', (state) => {
          if (state && state.isActive) { resendPushToken().catch(() => {}); }
        });
      } catch { /* @capacitor/app not available */ }
    })();
    return () => { try { sub && sub.remove(); } catch { /* ignore */ } };
  }, []);
  useEffect(() => { document.title = IS_TAGALONG ? 'TagAlong' : 'Dynamic Dispatch'; }, []);
  // Native app gets the edgy neon-glass "broker" skin (scoped via body.ta-app so
  // the web design stays exactly as-is).
  useEffect(() => {
    const native = typeof window !== 'undefined' && !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
    if (native && IS_TAGALONG) {
      document.body.classList.add('ta-app');
      // Fill the phone's safe areas (status bar + home indicator) with the dark
      // app color instead of white, so the skin runs edge-to-edge top and bottom.
      document.documentElement.classList.add('ta-app');
      document.documentElement.style.background = '#05070f';
      document.body.style.background = '#05070f';
    }
    return () => {
      document.body.classList.remove('ta-app');
      document.documentElement.classList.remove('ta-app');
    };
  }, []);
  useEffect(() => { // generate yesterday's driver reports on the first load of a new day
    autoGenerateIfNeeded();
    const t = setInterval(autoGenerateIfNeeded, 3600000); // hourly re-check
    return () => clearInterval(t);
  }, []);
  const [uiMuted, setUiMutedState] = useState(isUiMuted());
  const toggleMute = () => {
    const next = !uiMuted;
    setUiMuted(next);
    setUiMutedState(next);
  };

  const moveItem = (from, to) => {
    if (from === to || from == null || to == null) return;
    const next = [...menuItems];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setMenuItems(next);
    localStorage.setItem(MENU_ORDER_KEY, JSON.stringify(next.map((m) => m.path)));
  };

  // gate AFTER all hooks so hook order stays constant (Rules of Hooks)
  // Broker portal is a separate experience with its own login.
  if (typeof window !== 'undefined' && window.location.pathname.startsWith('/broker')) {
    return <BrokerPage />;
  }
  // Family / shared-access portal — its own login, full view of shared cars.
  if (typeof window !== 'undefined' && window.location.pathname.startsWith('/family')) {
    return <FamilyPage />;
  }
  // TagAlong Fleet — the commercial portal. Company account, drivers, and a
  // fleet-wide table sorted by what needs attention.
  if (typeof window !== 'undefined' && window.location.pathname.startsWith('/fleet')) {
    return <FleetPage />;
  }
  // Public legal pages — viewable without signing in (linked from sign-up + footer).
  if (typeof window !== 'undefined' && /^\/(privacy|terms|consent)$/.test(window.location.pathname)) {
    return <LegalPage which={window.location.pathname.slice(1)} />;
  }
  if (IS_TAGALONG && !authed && !bypassLogin) {
    return <LoginPage onLoggedIn={() => setAuthed(true)} />;
  }
  // Force first-login password change for phone-created accounts.
  if (IS_TAGALONG && authed && pwUser && !bypassLogin) {
    return <SetPasswordPage user={pwUser} onDone={() => setPwUser(null)} />;
  }
  // The admin dashboard requires an administrator sign-in (?admin still bypasses
  // for your own local testing).
  if (!IS_TAGALONG && !adminAuthed && !bypassLogin) {
    return <AdminLoginPage onLoggedIn={() => setAdminAuthed(true)} />;
  }

  return (
    <div className={`app-container ${IS_NATIVE && IS_TAGALONG && navCollapsed ? 'ta-nav-collapsed' : ''}`}>
      <AlertWatcher />
      {/* alert detail opened by tapping a push notification */}
      {pushAlert && <AlertDetailModal alert={pushAlert} onClose={() => setPushAlert(null)} />}
      <DispatchAutomation />
      <Autopilot />

      {/* sound toggle — mutes interface sounds only; alert sounds always play */}
      <button
        onClick={toggleMute}
        title={uiMuted ? 'Interface sounds are muted (alerts still sound). Click to unmute.' : 'Mute interface sounds — alert sounds always play'}
        style={{
          position: 'fixed', bottom: '16px', left: '16px', zIndex: 4000,
          width: '32px', height: '32px', borderRadius: '50%', padding: 0, fontSize: '14px',
          background: uiMuted ? '#94a3b8' : 'linear-gradient(135deg, #f97316, #f4511e)',
          color: 'white', boxShadow: '0 4px 14px rgba(0,0,0,0.45)', border: '1px solid rgba(255,255,255,0.35)',
        }}
      >
        {uiMuted ? '🔇' : '🔊'}
      </button>

      {/* native: floating handle to reopen the banner once it's collapsed */}
      {IS_NATIVE && IS_TAGALONG && navCollapsed && (
        <button
          className="ta-nav-handle"
          onClick={() => setNavCollapsed(false)}
          title="Show menu"
          aria-label="Show menu"
        >
          ▾
        </button>
      )}

      {/* Sidebar Navigation */}
      <nav className={`sidebar ${IS_NATIVE && IS_TAGALONG && navCollapsed ? 'ta-collapsed' : ''}`}>
        {IS_TAGALONG ? (
          <div className="logo" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '2px' }}>
            <TagAlongWordmark size={26} color="#ffffff" pin="#f8703c" />
            <span style={{ fontSize: '8px', letterSpacing: '1.5px', color: '#f8a37c', fontWeight: 700 }}>THE CAR THAT TALKS BACK</span>
            {authed && (() => { const me = getStoredMe(); return me ? <div className="ta-userchip" style={{ marginTop: '6px', fontSize: '10px', color: '#94a3b8' }}>Signed in as <b style={{ color: '#e2e8f0' }}>{me.name || me.email}</b><br /><span style={{ color: '#64748b' }}>{me.email}</span></div> : null; })()}
            {authed && <button className="ta-signout" onClick={async () => { await logout(); setAuthed(false); window.location.href = '/car?tagalong'; }} style={{ marginTop: '8px', background: 'rgba(255,255,255,0.1)', color: '#cbd5e1', border: '1px solid rgba(255,255,255,0.2)', borderRadius: '8px', padding: '5px 10px', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}>Sign out</button>}
          </div>
        ) : (
          <div className="logo" style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <Logo size={36} />
            <div>
              <h2>Dynamic Dispatch</h2>
              <span style={{ fontSize: '9px', letterSpacing: '1.5px', color: '#38bdf8', fontWeight: 600 }}>BY DYNAMICS BPO</span>
              {adminAuthed && <div><button onClick={() => { logoutAdmin(); setAdminAuthed(false); try { sessionStorage.removeItem('ta-admin-mode'); } catch { /* ignore */ } window.location.href = '/'; }} style={{ marginTop: '6px', background: 'rgba(255,255,255,0.1)', color: '#cbd5e1', border: '1px solid rgba(255,255,255,0.2)', borderRadius: '8px', padding: '4px 10px', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}>Sign out</button></div>}
            </div>
          </div>
        )}
        <ul className="nav-menu">
          {menuItems.filter((item) => (shopOnly ? item.path === '/shop'
            // Rentals hidden entirely when the product turns the feature off
            // (TagAlong Pro), otherwise gated on whether any car has it enabled.
            : (item.path !== '/rentals' || (hasFeature('rentals') && rentalsOn)))).map((item, i) => (
            <li
              key={item.path}
              draggable
              onDragStart={(e) => { setDragIndex(i); e.dataTransfer.effectAllowed = 'move'; }}
              onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
              onDrop={(e) => { e.preventDefault(); moveItem(dragIndex, i); setDragIndex(null); }}
              onDragEnd={() => setDragIndex(null)}
              style={{
                opacity: dragIndex === i ? 0.4 : 1,
                cursor: 'grab',
                borderTop: dragIndex != null && dragIndex !== i ? '2px solid transparent' : undefined,
              }}
            >
              <Link
                to={`${item.path}${TAGALONG_QS}`}
                className={`nav-link ${location.pathname === item.path ? 'active' : ''}`}
                onClick={(e) => { if (dragIndex != null) e.preventDefault(); }}
              >
                <span className="nav-icon">{item.icon}</span>
                <span className="nav-text">{item.name}</span>
                {item.path === '/orders' && orderBadge > 0 && (
                  <span style={{ background: '#f97316', color: 'white', fontSize: '10px', fontWeight: 800, borderRadius: '999px', padding: '1px 7px', marginLeft: '2px' }}>{orderBadge}</span>
                )}
                {item.path === '/vehicles' && brokerBadge > 0 && (
                  <span title="Broker approval pending" style={{ background: '#7c3aed', color: 'white', fontSize: '10px', fontWeight: 800, borderRadius: '999px', padding: '1px 7px', marginLeft: '2px' }}>🤝 {brokerBadge}</span>
                )}
                <span style={{ color: 'rgba(255,255,255,0.25)', fontSize: '11px', cursor: 'grab' }} title="Drag to reorder">⠿</span>
              </Link>
            </li>
          ))}
        </ul>
        {IS_NATIVE && IS_TAGALONG && (
          <button
            className="ta-nav-collapse"
            onClick={() => setNavCollapsed(true)}
            title="Hide menu for a full-screen view"
            aria-label="Hide menu"
          >
            ▴ Hide
          </button>
        )}
      </nav>

      {/* Main Content */}
      <main className="main-content">
        <Routes>
          <Route path="/" element={IS_TAGALONG ? <CarPage /> : <DashboardPage apiUrl={API_URL} />} />
          <Route path="/map" element={<MapPage apiUrl={API_URL} />} />
          <Route path="/history" element={<TripHistoryPage />} />
          <Route path="/drivers" element={<DriversPage apiUrl={API_URL} />} />
          <Route path="/vehicles" element={<VehiclesPage apiUrl={API_URL} />} />
          <Route path="/loads" element={<LoadsPage apiUrl={API_URL} />} />
          <Route path="/routes" element={<RoutesPage apiUrl={API_URL} />} />
          <Route path="/maintenance" element={<MaintenancePage apiUrl={API_URL} />} />
          <Route path="/compliance" element={<CompliancePage apiUrl={API_URL} />} />
          <Route path="/safety" element={<SafetyPage apiUrl={API_URL} />} />
          <Route path="/analytics" element={<AnalyticsPage apiUrl={API_URL} />} />
          <Route path="/cameras" element={<CamerasPage apiUrl={API_URL} />} />
          <Route path="/reports" element={<ReportsPage apiUrl={API_URL} />} />
          <Route path="/alerts" element={<AlertsPage apiUrl={API_URL} />} />
          <Route path="/health" element={<HealthPage />} />
          <Route path="/trailers" element={<TrailersPage />} />
          <Route path="/dispatch" element={<DispatchPage />} />
          <Route path="/trips" element={<TripsPage />} />
          <Route path="/car" element={<CarPage />} />
          <Route path="/intake" element={<IntakePage />} />
          <Route path="/customers" element={<CustomersPage />} />
          <Route path="/orders" element={<OrdersPage />} />
          <Route path="/rentals" element={<RentalsPage />} />
          <Route path="/shop" element={<ShopPage />} />
          <Route path="/products" element={<ProductsPage />} />
        </Routes>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <Router>
      <AppContent />
    </Router>
  );
}