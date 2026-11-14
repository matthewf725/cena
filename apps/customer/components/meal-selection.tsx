import { useEffect, useRef, useState, type ComponentRef } from 'react';
import { Animated, BackHandler, Easing, PanResponder, Platform, Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import { Check, ChevronDown, Clock3, Minus, Plus, X } from 'lucide-react-native';
import { normalizeMealSelections, type Meal, type MealOptionGroup, type MealSelections } from '../lib/data';
import { Text } from './type';
import { MealPrice } from './meal-price';

type Props = {
  meal: Meal;
  groups: MealOptionGroup[];
  onAdd: (quantity: number, selections: Record<string, string[]>) => void;
  onClose: () => void;
  reduced: boolean;
  bottomInset: number;
  topInset?: number;
  equipment?: string[];
  initialQuantity?: number;
  initialSelections?: MealSelections;
  returnFocusTo?: HTMLElement | null;
};

function validInitialSelections(groups: MealOptionGroup[], input: MealSelections = {}): MealSelections {
  const normalized = normalizeMealSelections(input);
  return Object.fromEntries(groups.flatMap(group => {
    const selected = (normalized[group.id] ?? []).filter(id => group.choices.some(choice => choice.id === id)).slice(0, group.max);
    return selected.length ? [[group.id, selected]] : [];
  }));
}

export function MealSelection({ meal, groups, onAdd, onClose, reduced, bottomInset, topInset=0, equipment, initialQuantity=1, initialSelections={}, returnFocusTo }: Props) {
  const { width, height } = useWindowDimensions();
  const scrollRef = useRef<ScrollView>(null);
  const groupOffsets = useRef<Record<string, number>>({});
  const [quantity, setQuantity] = useState(Math.min(50, Math.max(1, initialQuantity)));
  const [selections, setSelections] = useState<Record<string, string[]>>(() => validInitialSelections(groups, initialSelections));
  const [invalidGroupId, setInvalidGroupId] = useState<string|null>(null);
  const [limitMessage, setLimitMessage] = useState('');
  const sheetHeight = useRef(0);
  const [preparationExpanded, setPreparationExpanded] = useState(false);
  const preparationProgress = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(reduced ? 0 : 36)).current;
  const scrimOpacity = useRef(new Animated.Value(1)).current;
  const closing = useRef(false);
  const dragHandle = useRef<ComponentRef<typeof View>>(null);
  const sheetRef = useRef<ComponentRef<typeof View>>(null);
  const closeButton = useRef<ComponentRef<typeof Pressable>>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const radius = 20 + Math.max(0, Math.min(8, (390 - width) * 0.08));
  // Dynamic Island iPhones already include clearance below the island in the top safe area.
  const sheetTop = Platform.OS === 'ios' && topInset >= 54 ? topInset : Math.max(28, topInset + 12);
  const hasEquipment = equipment !== undefined;
  const needsEquipment = Boolean(meal.equipment && hasEquipment
    && !equipment.some(item => item.trim().toLowerCase() === meal.equipment!.trim().toLowerCase()));

  function closeAnimated() {
    if (closing.current) return;
    closing.current = true;
    if (reduced) {
      onCloseRef.current();
      return;
    }
    Animated.parallel([
      Animated.timing(translateY, { toValue: (sheetHeight.current || height - sheetTop) + 8, duration: 190, useNativeDriver: false }),
      Animated.timing(scrimOpacity, { toValue: 0, duration: 170, useNativeDriver: false }),
    ]).start(({ finished }) => { if (finished) onCloseRef.current(); });
  }

  const closeGesture = useRef(closeAnimated);
  closeGesture.current = closeAnimated;
  const panResponder = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponder: (_, gesture) => gesture.dy > 7 && Math.abs(gesture.dy) > Math.abs(gesture.dx) * 1.2,
    onPanResponderMove: (_, gesture) => { if(!closing.current)translateY.setValue(Math.max(0,gesture.dy)); },
    onPanResponderRelease: (_, gesture) => {
      if (gesture.dy > 110 || (gesture.dy > 18 && gesture.vy > 0.8)) closeGesture.current();
      else Animated.spring(translateY, { toValue: 0, useNativeDriver: false, speed: 22, bounciness: 3 }).start();
    },
    onPanResponderTerminate: () => {
      if (!closing.current) Animated.spring(translateY, { toValue: 0, useNativeDriver: false, speed: 22, bounciness: 3 }).start();
    },
  })).current;

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const handle = dragHandle.current as unknown as HTMLElement | null;
    if (!handle) return;
    let drag: { id: number; start: number } | null = null;
    const start = (event: PointerEvent) => {
      if (event.button !== 0 || closing.current) return;
      event.preventDefault();
      drag = { id: event.pointerId, start: event.clientY };
      handle.setPointerCapture?.(event.pointerId);
    };
    const move = (event: PointerEvent) => {
      if (drag?.id === event.pointerId) translateY.setValue(Math.max(0,event.clientY-drag.start));
    };
    const finish = (event: PointerEvent) => {
      if (drag?.id !== event.pointerId) return;
      const delta = event.clientY-drag.start;
      drag = null;
      if (event.type !== 'pointercancel' && delta > 80) closeGesture.current();
      else Animated.timing(translateY,{toValue:0,duration:reduced?0:140,useNativeDriver:false}).start();
    };
    handle.addEventListener('pointerdown',start);
    handle.addEventListener('pointermove',move);
    handle.addEventListener('pointerup',finish);
    handle.addEventListener('pointercancel',finish);
    return () => {
      handle.removeEventListener('pointerdown',start);
      handle.removeEventListener('pointermove',move);
      handle.removeEventListener('pointerup',finish);
      handle.removeEventListener('pointercancel',finish);
    };
  }, [reduced,translateY]);

  useEffect(() => {
    if (reduced) { translateY.setValue(0); return; }
    const opening = Animated.timing(translateY, { toValue: 0, duration: 160, easing: Easing.out(Easing.cubic), useNativeDriver: false });
    opening.start();
    return () => opening.stop();
  }, [reduced, translateY]);

  useEffect(() => {
    if (Platform.OS === 'android') {
      const back = BackHandler.addEventListener('hardwareBackPress', () => { closeGesture.current(); return true; });
      return () => back.remove();
    }
    if (Platform.OS !== 'web') return;
    const previous = returnFocusTo;
    const focus = requestAnimationFrame(() => closeButton.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeGesture.current(); return; }
      if (event.key !== 'Tab') return;
      const sheet = sheetRef.current as unknown as HTMLElement | null;
      const controls = sheet?.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex]:not([tabindex="-1"]):not([aria-disabled="true"])');
      if (!controls?.length) return;
      const first = controls[0], last = controls[controls.length - 1];
      if (!sheet?.contains(document.activeElement) || (event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      cancelAnimationFrame(focus);
      document.removeEventListener('keydown', onKeyDown);
      if (previous?.isConnected) requestAnimationFrame(() => previous?.focus());
    };
  }, [returnFocusTo]);

  function togglePreparation() {
    const expanded = !preparationExpanded;
    setPreparationExpanded(expanded);
    Animated.timing(preparationProgress, {
      toValue: expanded ? 1 : 0,
      duration: reduced ? 0 : 200,
      useNativeDriver: false,
    }).start();
  }

  function toggleChoice(group: MealOptionGroup, choiceId: string) {
    const current = selections[group.id] ?? [];
    const selected = current.includes(choiceId);
    const maximum = Math.max(0, group.max);
    let next: string[];
    if (selected) {
      next = current.filter(id => id !== choiceId);
    } else if (current.length >= maximum) {
      if (maximum === 1) next = [choiceId];
      else {
        setLimitMessage(`Choose up to ${maximum} ${group.name.toLowerCase()}${maximum === 1 ? '' : ' options'}.`);
        setInvalidGroupId(group.id);
        return;
      }
    } else {
      next = [...current, choiceId];
    }

    setSelections(value => ({ ...value, [group.id]: next }));
    setLimitMessage('');
    const minimum = Math.max(0, group.min);
    setInvalidGroupId(current => current === group.id && next.length >= minimum ? null : current);
  }

  function addToBag() {
    const missing = groups.find(group => (selections[group.id]?.length ?? 0) < Math.max(0, group.min));
    if (missing) {
      setInvalidGroupId(missing.id);
      setLimitMessage('');
      const offset = groupOffsets.current[missing.id];
      if (offset !== undefined) scrollRef.current?.scrollTo({ y: Math.max(0, offset - 18), animated: !reduced });
      return;
    }
    const normalized = Object.fromEntries(Object.entries(selections)
      .filter(([, choiceIds]) => choiceIds.length > 0)
      .map(([groupId, choiceIds]) => [groupId, [...choiceIds]]));
    onAdd(quantity, normalized);
  }

  return <View style={[styles.overlay, { top: -topInset }]}>
    <Animated.View style={[styles.scrim, { opacity: scrimOpacity }]}>
      <Pressable accessible={false} aria-hidden onPress={closeAnimated} style={StyleSheet.absoluteFillObject} />
    </Animated.View>
    <View pointerEvents="box-none" style={[styles.sheetFrame, { top: sheetTop }]}>
    <Animated.View ref={sheetRef} onLayout={event => { sheetHeight.current = event.nativeEvent.layout.height; }}
      {...(Platform.OS === 'web' ? { role: 'dialog', 'aria-modal': true, 'aria-label': meal.name } as const : { accessibilityViewIsModal: true })}
      style={[styles.sheet, { borderTopLeftRadius: radius, borderTopRightRadius: radius, transform: [{ translateY }] }]}>
      <View>
        <View ref={dragHandle} style={styles.dragRegion} {...(Platform.OS==='web'?{}:panResponder.panHandlers)}><View style={styles.dragHandle}/></View>
        <View style={styles.header}>
          <Pressable ref={closeButton} accessibilityRole="button" accessibilityLabel="Close meal options" onPress={closeAnimated} style={styles.close} hitSlop={8}>
            <X size={21} color={maroon}/>
          </Pressable>
          <View style={styles.headerText}>
            <Text accessibilityRole="header" style={styles.title}>{meal.name}</Text>
            {!!meal.subtitle && <Text style={styles.subtitle}>{meal.subtitle}</Text>}
            <MealPrice meal={meal}/>
          </View>
        </View>
      </View>

      <ScrollView ref={scrollRef} style={styles.scroll} contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled">
        {meal.tag && <View style={styles.tag}><Text style={styles.tagText}>{meal.tag}</Text></View>}
        {needsEquipment && <View style={styles.warning}>
          <Text style={styles.warningTitle}>You may need a {meal.equipment}</Text>
          <Text style={styles.warningText}>This meal kit recommends a {meal.equipment} to finish preparation at home.</Text>
        </View>}

        {groups.map(group => {
          const selectedIds = selections[group.id] ?? [];
          const invalid = invalidGroupId === group.id;
          return <View key={group.id} onLayout={event => { groupOffsets.current[group.id] = event.nativeEvent.layout.y; }} style={styles.group}>
            <View style={styles.groupHeading}>
              <View style={{ flex: 1 }}>
                <Text accessibilityRole="header" style={styles.groupTitle}>{group.name}</Text>
                <Text style={styles.groupHint}>{group.min > 0 ? `Choose at least ${group.min}` : 'Optional'}{group.max > 1 ? ` · up to ${group.max}` : ''}</Text>
              </View>
              {group.min > 0 && <Text style={styles.required}>Required</Text>}
            </View>
            {group.choices.map(choice => {
              const checked = selectedIds.includes(choice.id);
              return <Pressable key={choice.id} accessibilityRole={group.max === 1 ? 'radio' : 'checkbox'}
                accessibilityLabel={choice.name} accessibilityState={{ checked }} aria-checked={checked} onPress={() => toggleChoice(group, choice.id)}
                style={[styles.choice, checked && styles.choiceSelected, invalid && styles.choiceInvalid]}>
                <View style={[styles.checkmark, checked && styles.checkmarkSelected]}>{checked && <Check size={13} color="#FFF"/>}</View>
                <Text style={styles.choiceName}>{choice.name}</Text>
              </Pressable>;
            })}
            {invalid && <Text accessibilityRole="alert" style={styles.inlineError}>{limitMessage || `Choose at least ${group.min} option${group.min === 1 ? '' : 's'} to continue.`}</Text>}
          </View>;
        })}

        <View style={styles.preparation}>
          <Pressable accessibilityRole="button" accessibilityLabel={`Preparation${meal.prepMinutes ? `, estimated ${meal.prepMinutes} minutes` : ''}`}
            accessibilityState={{ expanded: preparationExpanded }} aria-expanded={preparationExpanded}
            onPress={togglePreparation} style={styles.preparationHeader}>
            <View style={styles.preparationHeading}>
              <Text style={styles.preparationTitle}>Preparation</Text>
              <View style={styles.preparationEstimate}>
                <Clock3 size={15} color={muted}/>
                <Text style={styles.preparationEstimateText}>{meal.prepMinutes ? `About ${meal.prepMinutes} min` : 'Estimated time'}</Text>
              </View>
            </View>
            <Animated.View style={{ transform: [{ rotate: preparationProgress.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '180deg'] }) }] }}>
              <ChevronDown size={19} color={muted}/>
            </Animated.View>
          </Pressable>
          <Animated.View pointerEvents={preparationExpanded ? 'auto' : 'none'} aria-hidden={!preparationExpanded}
            style={{ overflow: 'hidden', maxHeight: preparationProgress.interpolate({ inputRange: [0, 1], outputRange: [0, 600] }), opacity: preparationProgress }}>
            <View style={styles.preparationSteps}>
              {meal.publishedSteps?.length ? meal.publishedSteps.map((step, index) => <View key={`${index}-${step}`} style={styles.preparationStep}>
                <Text style={styles.preparationStepNumber}>{index + 1}</Text>
                <Text style={styles.preparationStepText}>{step}</Text>
              </View>) : <Text style={styles.preparationEmpty}>Preparation instructions will be available soon.</Text>}
            </View>
          </Animated.View>
        </View>

        <View style={styles.quantityRow}>
          <View style={{ flex: 1 }}><Text style={styles.quantityTitle}>Quantity</Text><Text style={styles.quantityHint}>Add up to 50</Text></View>
          <View style={styles.quantityControl}>
            <Pressable accessibilityRole="button" accessibilityLabel="Decrease quantity" accessibilityState={{ disabled: quantity <= 1 }}
              disabled={quantity <= 1} onPress={() => setQuantity(value => Math.max(1, value - 1))} style={[styles.quantityButton, quantity <= 1 && styles.dimmed]}>
              <Minus size={17} color={maroon}/>
            </Pressable>
            <Text accessibilityLabel={`Quantity ${quantity}`} style={styles.quantityValue}>{quantity}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Increase quantity" accessibilityState={{ disabled: quantity >= 50 }}
              disabled={quantity >= 50} onPress={() => setQuantity(value => Math.min(50, value + 1))} style={[styles.quantityButton, quantity >= 50 && styles.dimmed]}>
              <Plus size={17} color={maroon}/>
            </Pressable>
          </View>
        </View>
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: Math.max(14, bottomInset) }]}>
        <Pressable accessibilityRole="button" accessibilityLabel="Add to bag" onPress={addToBag} style={styles.addButton}>
          <Text style={styles.addButtonText}>Add to bag</Text>
        </Pressable>
      </View>
    </Animated.View>
    </View>
    </View>;
}

const maroon = '#5D100A';
const ink = '#271D19';
const muted = '#77645B';
const line = '#E8DCD5';

const styles = StyleSheet.create({
  overlay: { ...StyleSheet.absoluteFillObject, zIndex: 30 },
  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(28,18,14,.4)' },
  sheetFrame: { position: 'absolute', bottom: 0, left: 0, right: 0, alignItems: 'center' },
  sheet: { flex: 1, minHeight: 0, width: '100%', maxWidth: 720, backgroundColor: '#FAF6F3', overflow: 'hidden' },
  dragRegion: { minHeight: 26, justifyContent:'center', ...(Platform.OS==='web'?{touchAction:'none'}:{}) },
  dragHandle: { alignSelf: 'center', width: 38, height: 4, borderRadius: 3, backgroundColor: '#CFC0B8', marginBottom: 5 },
  header: { flexDirection: 'row', alignItems: 'flex-start', paddingHorizontal: 12, paddingTop: 4, paddingBottom: 13, borderBottomWidth: 1, borderBottomColor: line, gap: 8 },
  headerText: { flex: 1, minWidth: 0 },
  title: { color: ink, fontSize: 24, lineHeight: 30, fontWeight: '500' },
  subtitle: { color: muted, fontSize: 14, lineHeight: 20, marginTop: 3, marginBottom: 5 },
  close: { width: 44, height: 44, borderRadius: 22, borderWidth: 1, borderColor: line, backgroundColor: '#FFFDFA', alignItems: 'center', justifyContent: 'center', marginTop: -4 },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 21, paddingTop: 14, paddingBottom: 20 },
  tag: { alignSelf: 'flex-start', backgroundColor: '#F2E7E0', borderRadius: 16, paddingHorizontal: 10, paddingVertical: 6, marginBottom: 12 },
  tagText: { color: maroon, fontSize: 12, fontWeight: '500' },
  warning: { padding: 12, marginBottom: 16, borderRadius: 12, borderWidth: 1, borderColor: '#E5AAA1', backgroundColor: '#FFF0ED' },
  warningTitle: { color: '#A23B30', fontSize: 14, fontWeight: '500' },
  warningText: { color: '#87544D', fontSize: 13, lineHeight: 18, marginTop: 4 },
  group: { marginBottom: 18, paddingBottom: 14, borderBottomWidth: 1, borderBottomColor: line },
  groupHeading: { flexDirection: 'row', alignItems: 'center', marginBottom: 9, gap: 10 },
  groupTitle: { color: ink, fontSize: 17, lineHeight: 22, fontWeight: '500' },
  groupHint: { color: muted, fontSize: 12, marginTop: 2 },
  required: { color: maroon, fontSize: 11, fontWeight: '500' },
  choice: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 11, borderWidth: 1, borderColor: line, borderRadius: 11, backgroundColor: '#FFFDFA', marginTop: 7 },
  choiceSelected: { borderColor: '#B77A6E', backgroundColor: '#F8EFE9' },
  choiceInvalid: { borderColor: '#A23B30' },
  checkmark: { width: 20, height: 20, borderRadius: 10, borderWidth: 1, borderColor: '#BDAEA6', alignItems: 'center', justifyContent: 'center' },
  checkmarkSelected: { borderColor: maroon, backgroundColor: maroon },
  choiceName: { flex: 1, color: ink, fontSize: 14 },
  inlineError: { color: '#A23B30', fontSize: 12, lineHeight: 17, marginTop: 8 },
  preparation: { marginTop: 2, marginBottom: 14, borderBottomWidth: 1, borderBottomColor: line },
  preparationHeader: { minHeight: 54, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  preparationHeading: { flex: 1, flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 12 },
  preparationTitle: { color: ink, fontSize: 15, fontWeight: '500' },
  preparationEstimate: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  preparationEstimateText: { color: muted, fontSize: 12 },
  preparationSteps: { paddingTop: 2, paddingBottom: 14, gap: 12 },
  preparationStep: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  preparationStepNumber: { width: 22, height: 22, borderRadius: 11, overflow: 'hidden', backgroundColor: '#F2E7E0', color: maroon, textAlign: 'center', textAlignVertical: 'center', fontSize: 12, fontWeight: '500' },
  preparationStepText: { flex: 1, color: ink, fontSize: 14, lineHeight: 20 },
  preparationEmpty: { color: muted, fontSize: 13, lineHeight: 19 },
  quantityRow: { minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 2, marginBottom: 6 },
  quantityTitle: { color: ink, fontSize: 15, fontWeight: '500' },
  quantityHint: { color: muted, fontSize: 12, marginTop: 2 },
  quantityControl: { height: 42, flexDirection: 'row', alignItems: 'center', borderRadius: 12, borderWidth: 1, borderColor: line, backgroundColor: '#FFFDFA' },
  quantityButton: { width: 42, height: 40, alignItems: 'center', justifyContent: 'center' },
  quantityValue: { minWidth: 30, textAlign: 'center', color: ink, fontSize: 15, fontWeight: '500' },
  dimmed: { opacity: 0.45 },
  footer: { paddingHorizontal: 21, paddingTop: 12, borderTopWidth: 1, borderTopColor: line, backgroundColor: '#FAF6F3' },
  addButton: { minHeight: 54, alignItems: 'center', justifyContent: 'center', borderRadius: 14, backgroundColor: maroon },
  addButtonText: { color: '#FFF', fontSize: 16, fontWeight: '500' },
});
