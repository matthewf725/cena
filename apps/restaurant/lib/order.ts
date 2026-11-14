export type OrderStatus = 'New' | 'Accepted' | 'Preparing' | 'Ready' | 'Completed' | 'Cancelled';

export type Order = {
  id: string;
  backendId?: string;
  name: string;
  time: string;
  items: { name: string; qty: number; note?: string }[];
  total: number;
  discountCents?: number;
  status: OrderStatus;
  type: 'Pickup' | 'Curbside';
  slot: string;
  phone: string;
  paymentStatus?: 'paid' | 'refunded' | 'pay_at_pickup' | 'pending' | 'expired' | 'failed';
  applicationFeeCents?: number;
};
