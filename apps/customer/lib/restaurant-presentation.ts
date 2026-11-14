import type { ImageSourcePropType } from 'react-native';
import type { Kitchen } from './data';
import { foodPhoto } from './food-photos';

type DemoRestaurant = { photo: ImageSourcePropType; rating: string; ratingUrl: string };

// Google rating snapshots as displayed by Restaurant Guru on Nov 14, 2026.
// Luna Red and Mama’s Meatball cover photos come from their DoorDash storefronts.
// Piadina's artichoke pizza photo is from We Blog the World’s Hotel SLO feature.
// Giuseppe’s pizza photo is from its Downtown SLO listing.
const demoRestaurants: Record<string, DemoRestaurant> = {
  'cal-poly-luna-red': {
    photo: require('../assets/cal-poly-luna-red.webp'),
    rating: '4.5',
    ratingUrl: 'https://restaurantguru.com/Luna-Red-San-Luis-Obispo',
  },
  'cal-poly-mamas-meatball': {
    photo: require('../assets/cal-poly-mamas-meatball.webp'),
    rating: '4.4',
    ratingUrl: 'https://restaurantguru.com/Mamas-Meatball-San-Luis-Obispo-2',
  },
  'cal-poly-piadina': {
    photo: require('../assets/cal-poly-piadina.webp'),
    rating: '4.6',
    ratingUrl: 'https://es.restaurantguru.com/Piadina-San-Luis-Obispo',
  },
  'cal-poly-giuseppes': {
    photo: require('../assets/cal-poly-giuseppes.webp'),
    rating: '4.6',
    ratingUrl: 'https://restaurantguru.com/Giuseppes-Cucina-Rustica-San-Luis-Obispo-2',
  },
};

export function restaurantPhoto({ id, image }: Kitchen): ImageSourcePropType {
  return demoRestaurants[id]?.photo ?? foodPhoto(image.startsWith('http') ? id : image);
}

export function restaurantRating({ id, rating }: Kitchen) {
  return demoRestaurants[id]?.rating ?? rating;
}

export function restaurantRatingSource({ id }: Kitchen) {
  return demoRestaurants[id]?.ratingUrl;
}
