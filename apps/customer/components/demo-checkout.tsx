import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, BackHandler, Easing, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { ArrowLeft, Check, ChevronRight, CreditCard, MapPin } from 'lucide-react-native';
import { HeaderButton, PageHeader, headerTint, homeContentMaxWidth } from './home-chrome';
import { Text } from './type';

export const demoConfirmationMs = 5_000;

const sampleCards = ['Visa ****89', 'Mastercard ****42'] as const;
const maroon = '#5D100A', ink = '#271D19', muted = '#77645B', line = '#E8DCD5';

type CheckoutItem = {
  key: string;
  name: string;
  quantity: number;
  options: string;
};

type DemoCheckoutProps = {
  address: string;
  restaurantName: string;
  pickupLabel?: string;
  items?: CheckoutItem[];
  confirmationDeadline: number | null;
  topInset: number;
  bottomInset: number;
  reduced: boolean;
  onBack: () => void;
  onConfirm: () => void;
  onCancel: () => void;
};

export function DemoCheckout({
  address, restaurantName, pickupLabel, items = [], confirmationDeadline,
  topInset, bottomInset, reduced, onBack, onConfirm, onCancel,
}: DemoCheckoutProps) {
  const confirming = confirmationDeadline !== null;
  const [card, setCard] = useState<(typeof sampleCards)[number]>(sampleCards[0]);
  const [choosingCard, setChoosingCard] = useState(false);
  const remaining = useRef(new Animated.Value(1)).current;

  const goBack = useCallback(() => {
    if (confirming) onCancel();
    else if (choosingCard) setChoosingCard(false);
    else onBack();
  }, [confirming, choosingCard, onCancel, onBack]);

  useEffect(() => {
    if (Platform.OS === 'android') {
      const back = BackHandler.addEventListener('hardwareBackPress', () => { goBack(); return true; });
      return () => back.remove();
    }

    if (Platform.OS === 'web') {
      const onKey = (event: KeyboardEvent) => {
        if (event.key === 'Escape') { event.preventDefault(); goBack(); }
      };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }
  }, [goBack]);

  useEffect(() => {
    if (confirmationDeadline === null) return;

    const update = () => {
      const milliseconds = Math.max(0, confirmationDeadline - Date.now());
      remaining.setValue(Math.min(1, milliseconds / demoConfirmationMs));
      return milliseconds;
    };
    const milliseconds = update();

    if (reduced) {
      const interval = setInterval(update, 1000);
      return () => clearInterval(interval);
    }

    const animation = Animated.timing(remaining, {
      toValue: 0, duration: milliseconds, easing: Easing.linear, useNativeDriver: Platform.OS !== 'web',
    });
    animation.start();
    return () => animation.stop();
  }, [confirmationDeadline, reduced, remaining]);

  return <View style={s.page} testID="demo-checkout" onAccessibilityEscape={goBack}>
    <PageHeader identityHeight={58} topInset={topInset}>
      <View style={s.toolbar}>
        <HeaderButton label={confirming ? 'Back from confirmation' : 'Back to bag'} onPress={goBack} reduced={reduced}>
          <ArrowLeft size={22} color={maroon} aria-hidden />
        </HeaderButton>
        <Text accessibilityRole="header" style={s.toolbarTitle}>Checkout</Text>
        <View aria-hidden style={s.toolbarSpacer} />
      </View>
    </PageHeader>

    {confirming ? <View style={s.confirmingBody} testID="demo-checkout-confirming">
      <ActivityIndicator size="large" color={maroon} aria-hidden />
      <Text style={s.confirmingTitle}>Confirming order</Text>
    </View> : <ScrollView contentContainerStyle={s.content} showsVerticalScrollIndicator={false}>
      <View style={s.card}>
        <View style={s.row}>
          <View style={s.iconWell}><MapPin size={21} color={maroon} aria-hidden /></View>
          <View style={s.rowText}>
            <Text accessibilityRole="header" style={s.label}>Pickup</Text>
            <Text style={s.value}>{restaurantName}</Text>
            <Text style={s.secondary}>{address}</Text>
            {!!pickupLabel && <Text style={s.secondary}>{pickupLabel}</Text>}
          </View>
        </View>
      </View>

      <View style={s.card}>
        <Pressable accessibilityRole="button" accessibilityLabel={`Payment method, ${card}`} accessibilityState={{ expanded: choosingCard }}
          onPress={() => setChoosingCard(value => !value)} style={({ pressed }) => [s.row, pressed && s.pressed]}>
          <View style={s.iconWell}><CreditCard size={21} color={maroon} aria-hidden /></View>
          <View style={s.rowText}>
            <Text style={s.label}>Payment method</Text>
            <Text style={s.value}>{card}</Text>
          </View>
          <ChevronRight size={21} color={maroon} aria-hidden style={choosingCard && s.chevronOpen} />
        </Pressable>
        {choosingCard && <View accessibilityRole="radiogroup" accessibilityLabel="Payment methods" style={s.cardOptions}>
          {sampleCards.map(method => (
            <Pressable key={method} accessibilityRole="radio" accessibilityLabel={method} accessibilityState={{ checked: method === card }}
              onPress={() => { setCard(method); setChoosingCard(false); }} style={({ pressed }) => [s.choice, pressed && s.pressed]}>
              <Text style={s.value}>{method}</Text>
              <View style={[s.radio, method === card && s.radioChecked]} aria-hidden>
                {method === card && <Check size={12} color="#FFF" />}
              </View>
            </Pressable>
          ))}
        </View>}
      </View>

      {items.length > 0 && <View style={s.summary}>
        <Text accessibilityRole="header" style={s.summaryTitle}>Order summary</Text>
        {items.map(item => <View key={item.key} style={s.summaryItem}>
          <View style={s.itemDetails}>
            <Text style={s.value}>{item.name}</Text>
            {!!item.options && <Text style={s.secondary}>{item.options}</Text>}
          </View>
          <Text testID="demo-checkout-quantity" accessibilityLabel={`Quantity ${item.quantity}`} style={s.quantity}>{item.quantity}x</Text>
        </View>)}
      </View>}
    </ScrollView>}

    <View style={s.footer}>
      <View style={[s.footerInner, { paddingBottom: Math.max(16, bottomInset) }]}>
        {confirming ? <>
          <View role="status" accessibilityLiveRegion="polite" testID="demo-checkout-confirming-status" style={[s.action, s.primary]}>
            <Animated.View pointerEvents="none" aria-hidden testID="demo-checkout-progress"
              style={[s.remainder, { transform: [{ scaleX: remaining }] }]} />
            <Text style={s.primaryText}>Confirming order</Text>
          </View>
          <Pressable accessibilityRole="button" onPress={onCancel} style={({ pressed }) => [s.action, s.cancel, pressed && s.pressed]}>
            <Text style={s.cancelText}>Cancel order</Text>
          </Pressable>
        </> : <Pressable accessibilityRole="button" onPress={() => { setChoosingCard(false); onConfirm(); }}
            style={({ pressed }) => [s.action, s.primary, pressed && s.pressed]}>
            <Text style={s.primaryText}>Confirm order</Text>
          </Pressable>}
      </View>
    </View>
  </View>;
}

const s = StyleSheet.create({
  page: { flex: 1, minHeight: 0 },
  toolbar: { minHeight: 58, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 18, gap: 8 },
  toolbarTitle: { flex: 1, textAlign: 'center', fontSize: 22, fontWeight: '700', color: maroon },
  toolbarSpacer: { width: 44 },
  content: { width: '100%', maxWidth: homeContentMaxWidth, alignSelf: 'center', padding: 18, gap: 12 },
  confirmingBody: { flex: 1, paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center', gap: 16 },
  confirmingTitle: { color: ink, fontSize: 22, fontWeight: '600', textAlign: 'center' },
  card: { backgroundColor: '#FFF', borderWidth: 1, borderColor: line, borderRadius: 16, overflow: 'hidden' },
  row: { minHeight: 68, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 12, gap: 12 },
  rowText: { flex: 1, minWidth: 0, gap: 2 },
  iconWell: { width: 40, height: 40, borderRadius: 13, backgroundColor: '#FFF0E8', alignItems: 'center', justifyContent: 'center' },
  label: { fontSize: 13, fontWeight: '600', color: muted },
  value: { fontSize: 16, lineHeight: 21, fontWeight: '500', color: ink },
  secondary: { fontSize: 14, lineHeight: 19, color: muted },
  chevronOpen: { transform: [{ rotate: '90deg' }] },
  cardOptions: { borderTopWidth: 1, borderTopColor: line },
  choice: { minHeight: 48, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 1, borderColor: muted, alignItems: 'center', justifyContent: 'center' },
  radioChecked: { backgroundColor: maroon, borderColor: maroon },
  summary: { paddingTop: 5, paddingHorizontal: 2 },
  summaryTitle: { fontSize: 18, fontWeight: '600', color: ink, marginBottom: 2 },
  summaryItem: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: line },
  itemDetails: { flex: 1, minWidth: 0, gap: 2 },
  quantity: { fontSize: 16, lineHeight: 21, fontWeight: '600', color: maroon, fontVariant: ['tabular-nums'] },
  footer: { backgroundColor: '#FFFDFA', borderTopWidth: 1, borderTopColor: line },
  footerInner: { width: '100%', maxWidth: homeContentMaxWidth, alignSelf: 'center', paddingTop: 12, paddingHorizontal: 18, gap: 10 },
  action: { minHeight: 51, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 16, justifyContent: 'center', alignItems: 'center', overflow: 'hidden' },
  primary: { backgroundColor: maroon },
  primaryText: { color: '#FFF', fontSize: 17, fontWeight: '600', textAlign: 'center' },
  cancel: { backgroundColor: headerTint },
  cancelText: { color: maroon, fontSize: 16, fontWeight: '600', textAlign: 'center' },
  remainder: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, transformOrigin: 'right center', backgroundColor: '#FFFFFF30' },
  pressed: { opacity: 0.8 },
});
