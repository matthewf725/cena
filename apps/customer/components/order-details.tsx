import { useEffect, useRef, type ComponentRef } from 'react';
import { BackHandler, Platform, ScrollView, StyleSheet, View, type Pressable } from 'react-native';
import { ArrowLeft } from 'lucide-react-native';
import { HeaderButton, PageHeader, homeContentMaxWidth } from './home-chrome';
import { Text } from './type';

type OrderDetailsData = {
  code: string;
  restaurant: string;
  status: string;
  refunded: boolean;
  pickup: string;
  pickupMode: string;
  address?: string;
  total: string;
  savings?: string;
  items: {
    key: string;
    name: string;
    quantity: number;
    options: string[];
    steps: string[];
  }[];
};

export function OrderDetails({ order, identityHeight, topInset, bottomInset, reduced, onBack }: {
  order: OrderDetailsData;
  identityHeight: number;
  topInset: number;
  bottomInset: number;
  reduced: boolean;
  onBack: () => void;
}) {
  const backButton = useRef<ComponentRef<typeof Pressable>>(null);
  useEffect(() => {
    if (Platform.OS === 'android') {
      const subscription = BackHandler.addEventListener('hardwareBackPress', () => { onBack(); return true; });
      return () => subscription.remove();
    }
    if (Platform.OS === 'web') {
      const frame = requestAnimationFrame(() => backButton.current?.focus());
      const goBack = (event: KeyboardEvent) => {
        if (event.key === 'Escape') { event.preventDefault(); onBack(); }
      };
      window.addEventListener('keydown', goBack);
      return () => { cancelAnimationFrame(frame); window.removeEventListener('keydown', goBack); };
    }
  }, [onBack]);

  return <View style={s.page} testID="order-details-page">
    <PageHeader identityHeight={identityHeight} topInset={topInset}>
      <View style={[s.toolbar, { minHeight: identityHeight }]}>
        <HeaderButton ref={backButton} label="Back to orders" onPress={onBack} reduced={reduced}>
          <ArrowLeft size={22} color={maroon} aria-hidden/>
        </HeaderButton>
        <Text accessibilityRole="header" style={s.toolbarTitle}>Preparation instructions</Text>
        <View style={s.toolbarSpacer} aria-hidden/>
      </View>
    </PageHeader>
    <ScrollView contentContainerStyle={[s.content, { paddingBottom: bottomInset + 28 }]}>
      <View style={s.restaurantInfo}>
        <Text accessibilityRole="header" style={s.restaurant}>{order.restaurant}</Text>
        <Text style={[s.status, order.refunded && s.refunded]}>{order.status}</Text>
      </View>
      {order.items.map(item => <View key={item.key} style={s.item}>
        <Text accessibilityRole="header" style={s.itemName}>{item.quantity}× {item.name}</Text>
        {item.options.map((option, index) => <Text key={index} style={s.option}>{option}</Text>)}
        {item.steps.length ? item.steps.map((step, index) => <View key={index} style={s.step} testID="order-preparation-step">
          <View style={s.stepNumber}><Text style={s.stepNumberText}>{index + 1}</Text></View>
          <Text style={s.stepText}>{step}</Text>
        </View>) : <Text style={s.empty}>Check the package or ask the restaurant for preparation instructions.</Text>}
      </View>)}
      {!order.items.length && <Text style={s.empty}>Ask the restaurant for preparation instructions for this order.</Text>}
      <View style={s.summary}>
        <Text accessibilityRole="header" style={s.summaryTitle}>Pickup details</Text>
        <Text style={s.summaryText}>{order.pickup}</Text>
        <Text style={s.summaryText}>{order.pickupMode}{order.address ? ` · ${order.address}` : ''}</Text>
        <Text style={s.summaryText}>Order {order.code} · {order.total}</Text>
        {order.savings && <Text style={s.status}>{order.savings}</Text>}
      </View>
    </ScrollView>
  </View>;
}

const maroon = '#46110E', ink = '#271D19', muted = '#77645B', line = '#E8DCD5', green = '#245C40';
const s = StyleSheet.create({
  page: { flex: 1 },
  toolbar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, gap: 6 },
  toolbarTitle: { flex: 1, fontSize: 21, lineHeight: 24, fontWeight: '700', textAlign: 'center', color: maroon },
  toolbarSpacer: { width: 44 },
  content: { maxWidth: homeContentMaxWidth, width: '100%', alignSelf: 'center', paddingHorizontal: 20, paddingTop: 20, gap: 16 },
  restaurantInfo: { gap: 5 },
  restaurant: { fontSize: 29, lineHeight: 34, fontWeight: '700', color: ink },
  status: { fontSize: 15, lineHeight: 21, color: green },
  refunded: { color: '#A1382C' },
  item: { padding: 16, borderRadius: 16, borderWidth: 1, borderColor: line, backgroundColor: '#FFF' },
  itemName: { fontSize: 20, lineHeight: 26, fontWeight: '700', color: maroon },
  option: { fontSize: 14, lineHeight: 20, color: muted, marginTop: 4 },
  step: { flexDirection: 'row', alignItems: 'flex-start', columnGap: 12, marginTop: 14 },
  stepNumber: { minWidth: 26, height: 26, paddingHorizontal: 6, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFEDE5' },
  stepNumberText: { fontSize: 14, color: maroon, fontWeight: '700' },
  stepText: { flex: 1, fontSize: 17, lineHeight: 26, color: ink },
  empty: { fontSize: 16, lineHeight: 23, color: muted, marginTop: 8 },
  summary: { gap: 5, borderTopWidth: 1, borderTopColor: line, paddingTop: 14 },
  summaryTitle: { fontSize: 20, lineHeight: 25, fontWeight: '700', color: ink },
  summaryText: { fontSize: 15, lineHeight: 21, color: muted },
});
