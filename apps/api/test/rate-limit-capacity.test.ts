import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { errorHandler } from '@blacklabel/core';
import { RateLimiter } from '../src/security';
// Retained state is the property under test, independent of HTTP status.
const size=(limiter:RateLimiter)=>(limiter as unknown as {buckets:Map<string,unknown>}).buckets.size;
describe('bounded admission state',()=>{
 it('10,000 arbitrary paths share one source budget and retain one entry',()=>{
  const limiter=new RateLimiter({generalPerMinute:5,now:()=>1000});let allowed=0;
  for(let i=0;i<10000;i++)allowed+=Number(limiter.take('192.0.2.1',`/new-${i}/resource`));
  expect(allowed).toBe(5);expect(size(limiter)).toBe(1);
 });
 it('unknown and known route prefixes cannot reset the source budget',()=>{
  const limiter=new RateLimiter({generalPerMinute:3,now:()=>1000});
  expect(limiter.take('192.0.2.1','/api/health')).toBe(true);expect(limiter.take('192.0.2.1','/api/inventory/locations')).toBe(true);
  expect(limiter.take('192.0.2.1','/surprise')).toBe(true);expect(limiter.take('192.0.2.1','/another-surprise')).toBe(false);
  expect(limiter.take('192.0.2.2','/api/health')).toBe(true);
 });
 it('full capacity rejects new sources without evicting a depleted live source',()=>{
  const limiter=new RateLimiter({generalPerMinute:1,maxBuckets:2,now:()=>1000});
  expect(limiter.take('192.0.2.1','/api/health')).toBe(true);expect(limiter.take('192.0.2.2','/api/health')).toBe(true);
  for(let i=3;i<10003;i++)expect(limiter.take(`source-${i}`,'/api/health')).toBe(false);
  expect(size(limiter)).toBe(2);expect(limiter.take('192.0.2.1','/new')).toBe(false);
 });
 it('idle clients are reclaimed and remaining active clients retain their budget',()=>{
  let now=1000;const limiter=new RateLimiter({generalPerMinute:1,maxBuckets:2,idleMs:60000,now:()=>now});
  limiter.take('old','/');now=30000;limiter.take('active','/');now=61000;
  expect(limiter.take('new','/')).toBe(true);expect(size(limiter)).toBe(2);expect(limiter.take('active','/changed')).toBe(false);
 });
 it('auth operations share a stricter budget across every prefix and also consume general capacity',()=>{
  const limiter=new RateLimiter({generalPerMinute:4,authPerMinute:2,now:()=>1000});
  expect(limiter.take('ip','/api/admin/credentials')).toBe(true);expect(limiter.take('ip','/other/invitations')).toBe(true);
  expect(limiter.take('ip','/api/users/session-policy')).toBe(false);
  expect(limiter.take('ip','/api/health')).toBe(true);expect(limiter.take('ip','/api/inventory')).toBe(true);expect(limiter.take('ip','/api/crm')).toBe(false);
 });
 it('time refills the same budget without a backwards clock resetting it',()=>{
  let now=60000;const limiter=new RateLimiter({generalPerMinute:5,now:()=>now});
  for(let i=0;i<5;i++)expect(limiter.take('ip','/')).toBe(true);
  now=50000;expect(limiter.take('ip','/new')).toBe(false);now=60000;expect(limiter.take('ip','/newer')).toBe(false);
  now=72000;expect(limiter.take('ip','/api/health')).toBe(true);expect(limiter.take('ip','/again')).toBe(false);
 });
 it('oversized source strings collapse to a bounded shared identity',()=>{
  const limiter=new RateLimiter({generalPerMinute:1,now:()=>1000});expect(limiter.take('x'.repeat(2000),'/')).toBe(true);
  expect(limiter.take('y'.repeat(2000),'/')).toBe(false);expect(size(limiter)).toBe(1);
 });
 it('actual unauthenticated middleware rejects rotated missing routes before dispatch',async()=>{
  const limiter=new RateLimiter({generalPerMinute:3,now:()=>1000});const app=new Hono();app.onError(errorHandler);app.use('*',limiter.middleware());let dispatched=0;
  app.all('*',c=>{dispatched++;return c.json({missing:true},404);});
  for(let i=0;i<20;i++)expect((await app.request(`/missing-${i}`)).status).toBe(i<3?404:429);
  expect(dispatched).toBe(3);expect(size(limiter)).toBe(1);
 });
});
