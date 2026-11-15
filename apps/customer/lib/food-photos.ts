import type { ImageSourcePropType } from 'react-native';

const photos: Record<string, ImageSourcePropType> = {
  rigatoni: require('../assets/rigatoni.webp'),
  tacos: require('../assets/tacos.webp'),
  salmon: require('../assets/salmon.webp'),
  mediterranean: require('../assets/mediterranean.webp'),
  // Demo dish photos via Pexels (Nano Erdozain, 29039082 and Willians Huerta, 36430172).
  'giuseppes-carbonara': require('../assets/giuseppes-carbonara.webp'),
  'giuseppes-pomodoro': require('../assets/giuseppes-pomodoro.webp'),
};

const aliases: Record<string, string> = {
  mama: 'rigatoni',
  lasagna: 'rigatoni',
  gnocchi: 'rigatoni',
  pasta: 'rigatoni',
  sol: 'tacos',
  enchiladas: 'tacos',
  green: 'mediterranean',
  bowl: 'mediterranean',
  rice: 'mediterranean',
  'sunrise-cafe-cover': 'rigatoni',
  'little-fig-cover': 'salmon',
};

export function foodPhoto(key: string): ImageSourcePropType {
  return photos[key] ?? photos[aliases[key]] ?? photos.mediterranean;
}
