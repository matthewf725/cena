import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useRef, useState } from 'react';

export function useOrderBadgePreference(userId: string | null) {
  const key = `cena.customer.order-badge.v1.${userId ?? 'guest'}`;
  const [preference, setPreference] = useState<{ key: string; enabled: boolean } | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const savingKey = useRef<string | null>(null);
  const activeKey = useRef(key);
  activeKey.current = key;

  useEffect(() => {
    let current = true;
    void AsyncStorage.getItem(key).then(value => {
      if (current) setPreference({ key, enabled: value !== 'off' });
    }).catch(() => {
      if (current) setPreference({ key, enabled: true });
    });
    return () => { current = false; };
  }, [key]);

  async function update(enabled: boolean) {
    if (savingKey.current || preference?.key !== key) return;
    savingKey.current = key;
    setPending(key);
    setError(null);
    try {
      await AsyncStorage.setItem(key, enabled ? 'on' : 'off');
      if (activeKey.current === key) setPreference({ key, enabled });
    } catch {
      if (activeKey.current === key) setError({ key, message: 'Couldn’t save the badge setting. Try again.' });
    } finally {
      savingKey.current = null;
      setPending(null);
    }
  }

  return {
    enabled: preference?.key === key ? preference.enabled : true,
    loading: preference?.key !== key || pending === key,
    error: error?.key === key ? error.message : '',
    update,
  };
}

export type OrderBadgePreference = ReturnType<typeof useOrderBadgePreference>;
