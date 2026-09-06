import test from 'node:test'
import assert from 'node:assert/strict'
import { strapGeometry } from '../lib/pendant/strap-geometry.js'

test('each material has distinctive geometry at the same color', () => {
  const points=[{x:50,y:0},{x:50,y:180}], color='#617e73'
  const woven=strapGeometry(points,{material:'woven',color},58)
  const braided=strapGeometry(points,{material:'braided',color},58)
  const leather=strapGeometry(points,{material:'leather',color},58)
  assert.ok(woven.some(l=>l.id==='weft'))
  assert.ok(braided.some(l=>l.id==='overpass'))
  assert.ok(leather.some(l=>l.id==='double-stitch'))
  for(const layers of [woven,braided,leather]){
    assert.ok(layers.length<=8)
    assert.ok(layers.every(l=>l.d&&!/NaN|Infinity/.test(l.d)))
  }
  assert.notEqual(woven.at(-1).d,leather.at(-1).d)
})

test('texture follows the rope orientation and stays bounded on extreme drags', () => {
  const settings={material:'leather',color:'#617e73'}
  const vertical=strapGeometry([{x:0,y:0},{x:0,y:180}],settings,58).find(l=>l.id==='double-stitch')
  const horizontal=strapGeometry([{x:0,y:0},{x:180,y:0}],settings,58).find(l=>l.id==='double-stitch')
  const numbers=p=>p.d.match(/-?\d+(?:\.\d+)?/g).map(Number)
  const a=numbers(vertical),b=numbers(horizontal)
  for(let i=0;i<a.length;i+=2){assert.equal(Math.abs(a[i]),Math.abs(b[i+1]));assert.equal(a[i+1],b[i])}
  for(const material of ['woven','braided','leather']) {
    const layers=strapGeometry([{x:0,y:0},{x:10000,y:10000}],{...settings,material},58)
    assert.ok(layers.length<=8)
    assert.ok(layers.reduce((n,l)=>n+l.d.length,0)<90000)
  }
})

test('degenerate or invalid paths never emit invalid SVG', () => {
  const settings={material:'woven',color:'#617e73'}
  for(const points of [[],[{x:1,y:1}],[{x:1,y:1},{x:1,y:1}],[{x:NaN,y:0},{x:0,y:0}]])assert.deepEqual(strapGeometry(points,settings,58),[])
  assert.deepEqual(strapGeometry([{x:0,y:0},{x:1,y:1}],settings,0),[])
})
