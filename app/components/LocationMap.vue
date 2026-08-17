<script setup lang="ts">
import { Maximize2, Minimize2, Minus, Plus } from '@lucide/vue'

const props = withDefaults(defineProps<{ lat: number; lng: number; accuracy?: number; live?: boolean }>(), { accuracy: 0, live: false })
const host = ref<HTMLElement | null>(null)
const fullscreen = ref(false)
const mapError = ref('')
let amapLoader: Promise<any> | null = null
let map: any = null
let marker: any = null
let accuracyCircle: any = null

function amapPoint() { return [props.lng, props.lat] as [number, number] }
function accuracyCircleRadius() { return Number.isFinite(props.accuracy) ? Math.min(Math.max(props.accuracy, 8), 500) : 8 }
function zoomMap(delta: number) { if (!map?.getZoom || !map?.setZoom) return; map.setZoom(Math.min(20, Math.max(3, Number(map.getZoom()) + delta))) }

async function loadAmap() {
  if (!import.meta.client) throw new Error('高德地图只能在浏览器中加载')
  if ((window as any).AMap) return (window as any).AMap
  if (amapLoader) return amapLoader
  amapLoader = (async () => {
    const config = await $fetch<{ amapKey: string }>('/api/client-config')
    if (!config.amapKey) throw new Error('请在 NAS 配置 AMAP_KEY')
    ;(window as any)._AMapSecurityConfig = { serviceHost: `${location.origin}/_AMapService` }
    return await new Promise((resolve, reject) => {
      const script = document.querySelector<HTMLScriptElement>('script[data-love-amap]') || document.createElement('script')
      script.dataset.loveAmap = 'true'
      script.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(config.amapKey)}`
      script.onload = () => (window as any).AMap ? resolve((window as any).AMap) : reject(new Error('高德地图 API 加载失败'))
      script.onerror = () => reject(new Error('无法连接高德地图服务'))
      if (!script.parentNode) document.head.appendChild(script)
    })
  })()
  return amapLoader
}

async function renderMap() {
  if (!import.meta.client || !host.value) return
  try {
    const AMap = await loadAmap()
    mapError.value = ''
    if (!map) {
      map = new AMap.Map(host.value, { zoom: props.live ? 16 : 14, center: amapPoint(), resizeEnable: true, zooms: [3, 20], zoomEnable: true, dragEnable: true, doubleClickZoom: true, scrollWheel: true, touchZoom: true, mapStyle: 'amap://styles/normal' })
      if (AMap.ToolBar) map.addControl(new AMap.ToolBar({ position: 'RB', locate: false }))
      marker = new AMap.Marker({ position: amapPoint(), title: '共享位置' }); marker.setMap(map)
      accuracyCircle = new AMap.Circle({ center: amapPoint(), radius: accuracyCircleRadius(), strokeColor: '#a35ab0', strokeOpacity: .8, strokeWeight: 1, fillColor: '#d789b6', fillOpacity: .16 }); accuracyCircle.setMap(map)
    } else {
      map.setCenter(amapPoint()); marker?.setPosition(amapPoint()); accuracyCircle?.setCenter(amapPoint()); accuracyCircle?.setRadius(accuracyCircleRadius())
    }
    map.setZoom(props.live ? 16 : Math.max(map.getZoom?.() || 14, 14))
    window.setTimeout(() => map?.resize?.(), 0)
  } catch (error: any) { mapError.value = error?.message || '高德地图暂时不可用' }
}

watch(() => [props.lat, props.lng, props.accuracy, props.live], () => { void renderMap() })
watch(fullscreen, async value => { document.body.style.overflow = value ? 'hidden' : ''; await nextTick(); window.setTimeout(() => map?.resize?.(), 80) })
onMounted(() => { void renderMap() })
onBeforeUnmount(() => { if (fullscreen.value) document.body.style.overflow = ''; map?.destroy?.(); map = null; marker = null; accuracyCircle = null })
</script>

<template>
  <Teleport to="body" :disabled="!fullscreen">
    <div class="location-map-shell" :class="{ fullscreen }">
      <div ref="host" class="location-map" :class="{ live }" aria-label="共享位置地图" />
      <p v-if="mapError" class="map-error">{{ mapError }}</p>
      <div v-else class="map-controls" aria-label="地图缩放"><button type="button" title="放大地图" aria-label="放大地图" @pointerdown.stop @click.stop.prevent="zoomMap(1)"><Plus :size="17" /></button><button type="button" title="缩小地图" aria-label="缩小地图" @pointerdown.stop @click.stop.prevent="zoomMap(-1)"><Minus :size="17" /></button></div>
      <button class="map-fullscreen" type="button" :aria-label="fullscreen ? '退出全屏地图' : '全屏查看地图'" :title="fullscreen ? '退出全屏' : '全屏查看'" @pointerdown.stop @click.stop.prevent="fullscreen = !fullscreen"><Minimize2 v-if="fullscreen" :size="17" /><Maximize2 v-else :size="17" /></button>
    </div>
  </Teleport>
</template>

<style scoped>
.location-map-shell{position:relative;isolation:isolate;width:100%}.location-map-shell.fullscreen{position:fixed;z-index:140;inset:max(8px,env(safe-area-inset-top)) max(8px,env(safe-area-inset-right)) max(8px,env(safe-area-inset-bottom)) max(8px,env(safe-area-inset-left));padding:8px;border-radius:24px;background:rgba(36,24,45,.9);box-shadow:0 25px 80px rgba(35,15,48,.45)}
.location-map{position:relative;z-index:0;width:100%;height:220px;overflow:hidden;border-radius:16px;background:#dce9ef}.location-map.live{height:180px}.location-map-shell.fullscreen .location-map,.location-map-shell.fullscreen .location-map.live{height:100%;min-height:0;border-radius:18px}
.map-error{position:absolute;z-index:2;inset:0;display:grid;place-items:center;margin:0;padding:24px;border-radius:16px;background:linear-gradient(135deg,#f4edf7,#e8edf6);color:#725c7c;font-size:12px;text-align:center}
.map-fullscreen{position:absolute;z-index:1200;top:10px;right:10px;display:grid;place-items:center;width:36px;height:36px;border:1px solid rgba(255,255,255,.85);border-radius:12px;background:rgba(255,255,255,.9);color:#70467e;box-shadow:0 8px 22px rgba(52,25,66,.18);cursor:pointer}.location-map-shell.fullscreen .map-fullscreen{top:18px;right:18px}
.map-controls{position:absolute;z-index:1200;right:10px;bottom:10px;display:grid;gap:4px}.map-controls button{display:grid;place-items:center;width:34px;height:34px;border:1px solid rgba(255,255,255,.85);border-radius:11px;background:rgba(255,255,255,.9);color:#70467e;box-shadow:0 8px 22px rgba(52,25,66,.18);cursor:pointer}.location-map-shell.fullscreen .map-controls{right:18px;bottom:18px}
</style>
