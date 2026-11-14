export type Meal = { id: string; name: string; subtitle: string; price: number; was: number; image: string; tag?: string; equipment?: string; backendItemId?: string; publishedSteps?: string[] };
export type Kitchen = { id: string; name: string; cuisine: string; time: string; rating?: string; image: string; meals: Meal[]; backendId?: string; address?:string; timezone?:string; curbsideEnabled?: boolean; pickupSlots?: { id:string; startsAt:string; endsAt:string; cutoffAt:string; remaining:Record<string,number> }[] };
export const kitchens: Kitchen[] = [
  { id:'mama', name:'Nonna’s Table', cuisine:'Italian · Family recipes', time:'25–35 min', rating:'4.9', image:'https://images.unsplash.com/photo-1555396273-367ea4eb4db5?w=1000&auto=format&fit=crop&q=85', meals:[
    {id:'lasagna',name:'Sunday lasagna',subtitle:'Slow-simmered ragù, béchamel, fresh pasta',price:16,was:22,image:'https://images.unsplash.com/photo-1574894709920-11b28e7367e3?w=900&auto=format&fit=crop&q=85',tag:'BEST SELLER'},
    {id:'gnocchi',name:'Ricotta gnocchi',subtitle:'Brown butter, sage, shaved parmesan',price:14,was:19,image:'https://images.unsplash.com/photo-1551183053-bf91a1d81141?w=900&auto=format&fit=crop&q=85',equipment:'Oven'},
    {id:'tiramisu',name:'Classic tiramisù',subtitle:'Espresso-soaked ladyfingers, mascarpone',price:7,was:10,image:'https://images.unsplash.com/photo-1571877227200-a0d98ea607e9?w=900&auto=format&fit=crop&q=85'}
  ]},
  { id:'sol', name:'Sol y Sazón', cuisine:'Mexican · Bright & soulful', time:'20–30 min', rating:'4.8', image:'https://images.unsplash.com/photo-1552566626-52f8b828add9?w=1000&auto=format&fit=crop&q=85', meals:[
    {id:'enchiladas',name:'Roasted chicken enchiladas',subtitle:'Salsa verde, crema, cotija',price:15,was:20,image:'https://images.unsplash.com/photo-1534352956036-cd81e27dd615?w=900&auto=format&fit=crop&q=85',tag:'POPULAR'},
    {id:'tacos',name:'Mushroom tinga tacos',subtitle:'Three tortillas, pickled onion, avocado',price:13,was:18,image:'https://images.unsplash.com/photo-1551504734-5ee1c4a1479b?w=900&auto=format&fit=crop&q=85',equipment:'Stovetop'},
    {id:'rice',name:'Cilantro-lime rice',subtitle:'A little side with a lot of sunshine',price:5,was:7,image:'https://images.unsplash.com/photo-1516684732162-798a0062be99?w=900&auto=format&fit=crop&q=85'}
  ]},
  { id:'green', name:'The Greenhouse', cuisine:'Plant-forward · California', time:'30–40 min', rating:'4.9', image:'https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?w=1000&auto=format&fit=crop&q=85', meals:[{id:'bowl',name:'Golden harvest bowl',subtitle:'Crispy chickpeas, tahini, seasonal veg',price:14,was:19,image:'https://images.unsplash.com/photo-1512621776951-a57141f2eefd?w=900&auto=format&fit=crop&q=85'},{id:'pasta',name:'Lemon pea rigatoni',subtitle:'Spring peas, basil, toasted breadcrumbs',price:15,was:21,image:'https://images.unsplash.com/photo-1473093295043-cdd812d0e601?w=900&auto=format&fit=crop&q=85'}]}
];
