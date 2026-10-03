import { describe, expect, it } from 'vitest';
import { renderSite, type ProjectionSite } from '../src/render';

function fixture(): ProjectionSite {
  return {tenantId:'fixture',dataAsOf:'2026-09-13',departments:[],brands:[],items:[{
    id:'i1',sourceProductId:'p1',name:`Probe');globalThis.pwned=1;// & "<item>`,
    description:'</script><script>globalThis.pwned=1</script>',departmentSlug:null,departmentName:null,categoryName:null,brandSlug:null,brandName:null,slug:'probe-item',images:[],velocityRank:1,
    variations:[{id:`v'"<id>`,sourceVariationId:'sv1',name:`Size '" & <small>`,sku:null,priceCents:1000,state:'in_stock'}],
  }]};
}
describe('rendered catalog data is inert',()=>{
  it('script-closing text round trips through JSON-LD without ending the script',()=>{
    const site=fixture();const html=renderSite(site).byPath.get('item-probe-item.html')!.body;
    const script=html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)![1];
    expect(script).not.toContain('<');const product=JSON.parse(script);
    expect(product.description).toBe(site.items[0].description);expect(product.name).toBe(site.items[0].name);
    expect(html).not.toContain('<script>globalThis.pwned');
  });
  it('cart data is HTML-escaped in inert attributes instead of inline JavaScript',()=>{
    const html=renderSite(fixture()).byPath.get('item-probe-item.html')!.body;
    const button=html.match(/<button[^>]*data-add-to-cart[^>]*>/)![0];
    expect(button).not.toMatch(/\son\w+=/);expect(button).toContain('data-variation-id="v&#39;&quot;&lt;id&gt;"');
    expect(button).toContain('data-cart-price="1000"');expect(button).toContain('&amp;');
    expect(button).toContain('data-cart-name="Probe&#39;');
  });
  it('null price remains unknown and sold-out variants offer no purchase button',()=>{
    const site=fixture();site.items[0].variations[0].priceCents=null;
    expect(renderSite(site).byPath.get('item-probe-item.html')!.body).toContain('data-cart-price=""');
    site.items[0].variations[0].state='out';expect(renderSite(site).byPath.get('item-probe-item.html')!.body).not.toContain('data-add-to-cart');
  });
  it('the generated client script parses and retains search and cart hooks',()=>{
    const script=renderSite(fixture()).byPath.get('assets/app.js')!.body;
    expect(()=>new Function(script)).not.toThrow();expect(script).not.toContain('innerHTML');
    expect(script).toContain('textContent=e.n');expect(script).toContain('input.addEventListener("change"');
  });
});
