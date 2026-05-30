import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { api } from '../api/client';
import { useAuth } from './AuthContext';

const FavoritesContext = createContext(null);

const lsKey = (userId) => `fm_favorites_${userId}`;

function readFromStorage(userId) {
  try {
    const raw = localStorage.getItem(lsKey(userId));
    if (!raw) return null;
    const ids = JSON.parse(raw);
    if (Array.isArray(ids)) return new Set(ids);
  } catch { /* ignore */ }
  return null;
}

function writeToStorage(userId, favorites) {
  try {
    localStorage.setItem(lsKey(userId), JSON.stringify([...favorites]));
  } catch { /* ignore */ }
}

export function FavoritesProvider({ children }) {
  const { user } = useAuth();
  const [favorites, setFavorites] = useState(new Set());
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!user || user.role !== 'buyer') {
      setFavorites(new Set());
      return;
    }

    // Initialize immediately from localStorage so UI is responsive before API
    const cached = readFromStorage(user.id);
    if (cached) setFavorites(cached);

    setLoading(true);
    api.getFavorites({ limit: 1000 })
      .then(res => {
        const ids = new Set((res.data || []).map(p => p.id));
        setFavorites(ids);
        writeToStorage(user.id, ids);
      })
      .catch(() => {
        if (!cached) setFavorites(new Set());
      })
      .finally(() => setLoading(false));
  }, [user]);

  const toggleFavorite = useCallback(async (productId) => {
    if (!user || user.role !== 'buyer') return;

    const isFavorited = favorites.has(productId);
    const newFavorites = new Set(favorites);

    try {
      if (isFavorited) {
        newFavorites.delete(productId);
        setFavorites(newFavorites);
        writeToStorage(user.id, newFavorites);
        await api.removeFavorite(productId);
      } else {
        newFavorites.add(productId);
        setFavorites(newFavorites);
        writeToStorage(user.id, newFavorites);
        await api.addFavorite(productId);
      }
    } catch (err) {
      // Revert on error
      setFavorites(favorites);
      writeToStorage(user.id, favorites);
      throw err;
    }
  }, [user, favorites]);

  const isFavorited = useCallback((productId) => {
    return favorites.has(productId);
  }, [favorites]);

  return (
    <FavoritesContext.Provider value={{ favorites, loading, toggleFavorite, isFavorited }}>
      {children}
    </FavoritesContext.Provider>
  );
}

export function useFavorites() {
  return useContext(FavoritesContext);
}
