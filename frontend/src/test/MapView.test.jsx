import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// Mock react-leaflet and leaflet to avoid DOM/canvas issues in jsdom
vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }) => <div data-testid="map">{children}</div>,
  TileLayer: () => null,
  Marker: ({ children, icon, eventHandlers, position }) => (
    <div
      data-testid={icon ? 'cluster-marker' : 'farm-marker'}
      data-position={JSON.stringify(position)}
      onClick={eventHandlers?.click}
    >
      {children}
    </div>
  ),
  Popup: ({ children }) => <div>{children}</div>,
  Circle: () => null,
  useMap: () => ({ setView: vi.fn(), getZoom: () => 7 }),
  useMapEvents: (handlers) => { void handlers; return null; },
}));
vi.mock('leaflet', () => ({
  default: {
    Icon: { Default: { prototype: {}, mergeOptions: vi.fn() } },
    divIcon: vi.fn(() => ({ mockIcon: true })),
  },
  Icon: { Default: { prototype: {}, mergeOptions: vi.fn() } },
  divIcon: vi.fn(() => ({ mockIcon: true })),
}));
vi.mock('leaflet/dist/leaflet.css', () => ({}));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));

import MapView from '../components/MapView';

const products = [{ id: 1, name: 'Apples', price: '2', unit: 'kg', farmer_name: 'Bob', farmer_lat: 1.0, farmer_lng: 1.0 }];

// Products spread far apart — should NOT cluster at zoom 7
const spreadProducts = [
  { id: 1, name: 'Apples', price: '2', unit: 'kg', farmer_name: 'Bob', farmer_lat: 1.0, farmer_lng: 1.0 },
  { id: 2, name: 'Corn', price: '3', unit: 'kg', farmer_name: 'Alice', farmer_lat: 20.0, farmer_lng: 20.0 },
];

// Products close together — should cluster at zoom 7
const denseProducts = [
  { id: 1, name: 'Apples', price: '2', unit: 'kg', farmer_name: 'Bob', farmer_lat: 1.0, farmer_lng: 1.0 },
  { id: 2, name: 'Corn', price: '3', unit: 'kg', farmer_name: 'Alice', farmer_lat: 1.01, farmer_lng: 1.01 },
  { id: 3, name: 'Beans', price: '1', unit: 'kg', farmer_name: 'Carol', farmer_lat: 1.02, farmer_lng: 1.02 },
];

describe('MapView geolocation error handling (#439)', () => {
  let originalGeo;

  beforeEach(() => { originalGeo = navigator.geolocation; });
  afterEach(() => { Object.defineProperty(navigator, 'geolocation', { value: originalGeo, configurable: true }); });

  it('shows toast and renders map when geolocation is denied (code 1)', async () => {
    Object.defineProperty(navigator, 'geolocation', {
      value: {
        getCurrentPosition: (_success, error) => error({ code: 1, message: 'User denied' }),
      },
      configurable: true,
    });
    render(<MapView products={products} />);
    expect(await screen.findByText('Location access denied. Showing default location.')).toBeInTheDocument();
    expect(screen.getByTestId('map')).toBeInTheDocument();
  });

  it('does not show toast on success', async () => {
    Object.defineProperty(navigator, 'geolocation', {
      value: {
        getCurrentPosition: (success) => success({ coords: { latitude: 10, longitude: 20 } }),
      },
      configurable: true,
    });
    render(<MapView products={products} />);
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  });
});

describe('MapView cluster rendering (#797)', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'geolocation', {
      value: { getCurrentPosition: (_s, error) => error({ code: 2 }) },
      configurable: true,
    });
  });

  it('renders individual farm markers when pins are spread far apart', () => {
    render(<MapView products={spreadProducts} />);
    // Two distinct locations far apart — two separate farm markers, no cluster
    const farmMarkers = screen.getAllByTestId('farm-marker');
    expect(farmMarkers.length).toBe(2);
    expect(screen.queryByTestId('cluster-marker')).toBeNull();
  });

  it('renders a single cluster marker when multiple farms are nearby', () => {
    render(<MapView products={denseProducts} />);
    // All three farms are within cluster radius — should appear as one cluster
    const clusterMarkers = screen.getAllByTestId('cluster-marker');
    expect(clusterMarkers.length).toBe(1);
    expect(screen.queryByTestId('farm-marker')).toBeNull();
  });

  it('cluster popup shows count and zoom button', () => {
    render(<MapView products={denseProducts} />);
    expect(screen.getByText('3 farms in this area')).toBeInTheDocument();
    expect(screen.getByText('Zoom in to see farms')).toBeInTheDocument();
  });
});
