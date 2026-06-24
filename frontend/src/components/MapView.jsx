import React, { useEffect, useState } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Circle, useMap } from 'react-leaflet';
import { useNavigate } from 'react-router-dom';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// Fix default marker icons broken by webpack/vite bundling
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

const DEFAULT_CENTER = [0, 0];

const s = {
  popup: { minWidth: 180 },
  name: { fontWeight: 700, fontSize: 14, color: '#2d6a4f', marginBottom: 4 },
  price: { fontWeight: 600, color: '#333', fontSize: 13, marginBottom: 4 },
  farmer: { fontSize: 12, color: '#888', marginBottom: 8 },
  address: { fontSize: 11, color: '#aaa', marginBottom: 8 },
  btn: {
    display: 'inline-block', background: '#2d6a4f', color: '#fff',
    border: 'none', borderRadius: 6, padding: '5px 12px', cursor: 'pointer',
    fontSize: 12, fontWeight: 600, textDecoration: 'none',
  },
  toast: {
    position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)',
    background: '#333', color: '#fff', padding: '8px 16px', borderRadius: 8,
    fontSize: 13, zIndex: 1000, pointerEvents: 'none',
  },
};

function groupByFarmer(products) {
  const map = new Map();
  for (const p of products) {
    if (p.farmer_lat == null || p.farmer_lng == null) continue;
    const key = `${p.farmer_lat},${p.farmer_lng}`;
    if (!map.has(key)) map.set(key, { lat: p.farmer_lat, lng: p.farmer_lng, farmerName: p.farmer_name, products: [] });
    map.get(key).products.push(p);
  }
  return Array.from(map.values());
}

// Calculate distance between two coordinates in km
function calculateDistance(lat1, lng1, lat2, lng2) {
  const R = 6371; // Earth's radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function RecenterMap({ center }) {
  const map = useMap();
  useEffect(() => { map.setView(center, map.getZoom()); }, [center, map]);
  return null;
}

export default function MapView({ products = [], lat, lng, farmerName, onFarmerClick }) {
  const navigate = useNavigate();
  const hasSingleLocation = lat != null && lng != null;
  const groups = hasSingleLocation
    ? [{ lat, lng, farmerName, products: [] }]
    : groupByFarmer(products);
  const [center, setCenter] = useState(null);
  const [toast, setToast] = useState('');

  useEffect(() => {
    if (!navigator.geolocation) {
      setCenter(DEFAULT_CENTER);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => setCenter([pos.coords.latitude, pos.coords.longitude]),
      (err) => {
        if (err.code === 1) {
          setToast('Location access denied. Showing default location.');
          setTimeout(() => setToast(''), 4000);
        }
        setCenter(DEFAULT_CENTER);
      }
    );
  }, []);

  if (groups.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '60px 0', color: '#888' }}>
        <div style={{ fontSize: 40, marginBottom: 12 }}>🗺️</div>
        <div>No products with location data yet.</div>
        <div style={{ fontSize: 13, marginTop: 6 }}>Farmers can add their location in profile settings.</div>
      </div>
    );
  }

  const avgLat = groups.reduce((sum, g) => sum + g.lat, 0) / groups.length;
  const avgLng = groups.reduce((sum, g) => sum + g.lng, 0) / groups.length;
  const mapCenter = center ?? [avgLat, avgLng];

  return (
    <div style={{ position: 'relative' }}>
      {toast && <div style={s.toast} role="status">{toast}</div>}
      <MapContainer
        center={[avgLat, avgLng]}
        zoom={7}
        style={{ height: 520, width: '100%', borderRadius: 12, zIndex: 0 }}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        {center && <RecenterMap center={mapCenter} />}
        {groups.map((group, i) => (
          <React.Fragment key={i}>
            <Marker position={[group.lat, group.lng]}>
              <Popup>
                <div style={s.popup}>
                  {group.products.length > 0 ? (
                    group.products.map((p) => (
                      <div
                        key={p.id}
                        style={{
                          marginBottom: group.products.length > 1 ? 12 : 0,
                          paddingBottom: group.products.length > 1 ? 12 : 0,
                          borderBottom: group.products.length > 1 ? '1px solid #eee' : 'none',
                        }}
                      >
                        <div style={s.name}>{p.name}</div>
                        <div style={s.price}>{p.price} XLM / {p.unit}</div>
                        <div style={s.farmer}>🌾 {p.farmer_name}</div>
                        {p.farmer_farm_address && <div style={s.address}>📍 {p.farmer_farm_address}</div>}
                        <button style={s.btn} onClick={() => navigate(`/products/${p.id}`)}>View &amp; Buy</button>
                      </div>
                    ))
                  ) : (
                    <div>
                      <div style={s.name}>{group.farmerName || 'Farm location'}</div>
                      <div style={s.farmer}>🌾 {group.farmerName || 'Farmer'}</div>
                    </div>
                  )}
                </div>
              </Popup>
            </Marker>
            {group.products.some((p) => p.delivery_radius && p.origin_lat != null && p.origin_lng != null) &&
              group.products.map((p) => {
                if (!p.delivery_radius || p.origin_lat == null || p.origin_lng == null) return null;
                const radiusKm = p.delivery_radius > 1000 ? p.delivery_radius / 1000 : p.delivery_radius;
                return (
                  <Circle
                    key={`geo-${p.id}`}
                    center={[p.origin_lat, p.origin_lng]}
                    radius={radiusKm * 1000}
                    pathOptions={{ color: '#2d6a4f', weight: 2, opacity: 0.5, fillColor: '#d8f3dc', fillOpacity: 0.1 }}
                  />
                );
              })}
          </React.Fragment>
        ))}
      </MapContainer>
    </div>
  );
}
