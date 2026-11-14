import { forwardRef } from 'react';
import { StyleSheet, Text as NativeText, TextInput as NativeTextInput, type TextInputProps, type TextProps } from 'react-native';

export const sans = 'Atkinson Hyperlegible Next';

export function Text({ style, ...props }: TextProps) {
  return <NativeText {...props} style={[type.body, style]} />;
}

export const TextInput = forwardRef<NativeTextInput, TextInputProps>(function TextInput({ style, ...props }, ref) {
  return <NativeTextInput {...props} ref={ref} style={[type.body, style]} />;
});

const type = StyleSheet.create({ body: { fontFamily: sans } });
