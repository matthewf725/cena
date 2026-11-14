import React from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

export type RestaurantOptionChoice = { id: string; name: string };
export type RestaurantOptionGroup = {
  id: string;
  name: string;
  min: number;
  max: number;
  choices: RestaurantOptionChoice[];
};

type Props = {
  groups: RestaurantOptionGroup[];
  onChange: (groups: RestaurantOptionGroup[]) => void;
};

const MAROON = '#5D100A';
const INK = '#261C19';
const MUTED = '#766B66';
const LINE = '#E8DDD7';

const makeId = (prefix: string) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function validateRestaurantOptionGroups(groups: RestaurantOptionGroup[]): string | null {
  if (groups.length > 12) return 'Use 12 option groups or fewer.';
  if (groups.reduce((total, group) => total + (Number.isInteger(group.max) ? group.max : 0), 0) > 20) return 'The maximum selections across all groups cannot exceed 20.';
  const ids = new Set<string>();
  for (const group of groups) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(group.id) || ids.has(group.id)) return 'Each option group needs a unique valid ID.';
    ids.add(group.id);
    if (!group.name.trim() || group.name.trim().length > 100) return 'Give each option group a name (up to 100 characters).';
    if (!Number.isInteger(group.min) || !Number.isInteger(group.max) || group.min < 0 || group.min > 20 || group.max < 1 || group.max > 20 || group.min > group.max || group.max > group.choices.length) {
      return `Check the minimum and maximum selections for “${group.name}”.`;
    }
    if (group.choices.length > 50) return 'Each option group can have up to 50 choices.';
    const choiceIds = new Set<string>();
    for (const choice of group.choices) {
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(choice.id) || choiceIds.has(choice.id)) return `Choices in “${group.name}” need unique valid IDs.`;
      choiceIds.add(choice.id);
      if (!choice.name.trim() || choice.name.trim().length > 100) return `Give each choice in “${group.name}” a name (up to 100 characters).`;
    }
  }
  return null;
}

export function OptionGroupEditor({ groups, onChange }: Props) {
  const patchGroup = (index: number, patch: Partial<RestaurantOptionGroup>) => onChange(groups.map((group, i) => i === index ? { ...group, ...patch } : group));

  return (
    <View style={{ marginTop: 22, paddingTop: 16, borderTopWidth: 1, borderColor: LINE }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Text style={{ color: INK, fontSize: 15, fontWeight: '800' }}>Meal options</Text>
          <Text style={{ color: MUTED, fontSize: 12, marginTop: 3 }}>Add choices customers can select. Options don’t change the item price.</Text>
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="Add option group" accessibilityState={{ disabled: groups.length >= 12 }} disabled={groups.length >= 12} onPress={() => onChange([...groups, { id: makeId('group'), name: '', min: 0, max: 1, choices: [{ id: makeId('choice'), name: '' }] }])} style={{ borderRadius: 10, borderWidth: 1, borderColor: MAROON, paddingHorizontal: 12, paddingVertical: 9, opacity: groups.length >= 12 ? 0.5 : 1 }}>
          <Text style={{ color: MAROON, fontWeight: '700', fontSize: 12 }}>Add group</Text>
        </Pressable>
      </View>
      {groups.length === 0 ? <Text style={{ color: MUTED, fontSize: 13, marginTop: 12 }}>No selectable options yet.</Text> : null}
      {groups.map((group, groupIndex) => (
        <View key={group.id} style={{ marginTop: 14, padding: 12, backgroundColor: '#FFF', borderWidth: 1, borderColor: LINE, borderRadius: 12 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <TextInput accessibilityLabel={`Option group ${groupIndex + 1} name`} placeholder="Group name (e.g. Choose a side)" value={group.name} onChangeText={name => patchGroup(groupIndex, { name })} style={{ flex: 1, minWidth: 0, borderWidth: 1, borderColor: LINE, borderRadius: 9, paddingHorizontal: 10, paddingVertical: 9, color: INK }} />
            <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${group.name || 'option group'}`} onPress={() => onChange(groups.filter((_, i) => i !== groupIndex))} hitSlop={8} style={{ padding: 8 }}><Text style={{ color: MAROON, fontSize: 18, fontWeight: '700' }}>×</Text></Pressable>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 }}>
            <Text style={{ color: MUTED, fontSize: 12 }}>Selections</Text>
            <TextInput accessibilityLabel={`Minimum selections for ${group.name || 'option group'}`} keyboardType="number-pad" value={String(group.min)} onChangeText={v => patchGroup(groupIndex, { min: Number(v.replace(/\D/g, '').slice(0, 2)) || 0 })} style={{ width: 52, textAlign: 'center', borderWidth: 1, borderColor: LINE, borderRadius: 8, paddingVertical: 7, color: INK }} />
            <Text style={{ color: MUTED, fontSize: 12 }}>to</Text>
            <TextInput accessibilityLabel={`Maximum selections for ${group.name || 'option group'}`} keyboardType="number-pad" value={String(group.max)} onChangeText={v => patchGroup(groupIndex, { max: Number(v.replace(/\D/g, '').slice(0, 2)) || 0 })} style={{ width: 52, textAlign: 'center', borderWidth: 1, borderColor: LINE, borderRadius: 8, paddingVertical: 7, color: INK }} />
          </View>
          <Text style={{ color: MUTED, fontSize: 12, fontWeight: '700', marginTop: 13 }}>CHOICES</Text>
          {group.choices.map((choice, choiceIndex) => (
            <View key={choice.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 7 }}>
              <TextInput accessibilityLabel={`Choice ${choiceIndex + 1} in ${group.name || 'option group'}`} placeholder="Choice name" value={choice.name} onChangeText={name => patchGroup(groupIndex, { choices: group.choices.map((item, i) => i === choiceIndex ? { ...item, name } : item) })} style={{ flex: 1, minWidth: 0, borderWidth: 1, borderColor: LINE, borderRadius: 9, paddingHorizontal: 10, paddingVertical: 8, color: INK }} />
              <Pressable accessibilityRole="button" accessibilityLabel={`Remove choice ${choice.name || choiceIndex + 1}`} onPress={() => patchGroup(groupIndex, { choices: group.choices.filter((_, i) => i !== choiceIndex) })} hitSlop={8} style={{ padding: 7 }}><Text style={{ color: MUTED, fontSize: 18 }}>×</Text></Pressable>
            </View>
          ))}
          <Pressable accessibilityRole="button" accessibilityLabel={`Add choice to ${group.name || 'option group'}`} accessibilityState={{ disabled: group.choices.length >= 50 }} disabled={group.choices.length >= 50} onPress={() => patchGroup(groupIndex, { choices: [...group.choices, { id: makeId('choice'), name: '' }] })} style={{ alignSelf: 'flex-start', paddingVertical: 9, paddingRight: 8, opacity: group.choices.length >= 50 ? 0.5 : 1 }}>
            <Text style={{ color: MAROON, fontSize: 12, fontWeight: '700' }}>+ Add choice</Text>
          </Pressable>
        </View>
      ))}
    </View>
  );
}
