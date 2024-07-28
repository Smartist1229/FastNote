import { createApp } from 'vue'
import App from './App.vue'


const app = createApp(App)

app.directive('myfocus', {
    mounted: (el, binding) => {
        if (binding.value == true || binding.value == undefined) {
            el.focus()
        }
    }
})

app.mount('#app')