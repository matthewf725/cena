import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from './type';

type Props = { children: ReactNode; restaurantLabel: string; onRetry: () => void };

export class RestaurantMenuBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Restaurant menu render failed', error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return <View style={styles.message}>
      <Text style={styles.title}>{this.props.restaurantLabel}</Text>
      <Text style={styles.detail}>The menu couldn’t open. Try again or go back to browse other restaurants.</Text>
      <Pressable accessibilityRole="button" style={styles.retry} onPress={() => {
        this.props.onRetry();
        this.setState({ failed: false });
      }}><Text style={styles.retryText}>Try again</Text></Pressable>
    </View>;
  }
}

const styles = StyleSheet.create({
  message: { padding: 22, gap: 12 },
  title: { color: '#271D19', fontSize: 23, fontWeight: '500' },
  detail: { color: '#77645B', fontSize: 16 },
  retry: { alignSelf: 'flex-start', justifyContent: 'center', minHeight: 44, paddingHorizontal: 16, borderRadius: 22, backgroundColor: '#5D100A' },
  retryText: { color: '#FFFFFF', fontSize: 15, fontWeight: '500' },
});
