# ¿Qué pasóoo?

La oficina de vacaciones del equipo: quién está en la playa, una cajita para dejarle tareas, chismes y conflictos a quien se fue, y un árbol bajo llave para leerlos a la vuelta.

## Cómo está armado

- `public/index.html`: la página.
- `netlify/functions/api.mjs`: el servidor. Guarda todo en Netlify Blobs (el almacenamiento propio de Netlify) y revisa las claves.

## Publicarlo en Netlify (una sola vez)

1. Entrá a https://app.netlify.com, tocá **Add new site → Import an existing project → GitHub** y elegí este repo. No hace falta cambiar nada de la configuración: tocá **Deploy**.
2. En el sitio, andá a **Site configuration → Environment variables** y agregá:
   - `CLAVES`: quién puede abrir el árbol, con este formato:
     `Agus:una-clave-larga:todo, Viki:otra-clave`
     El `:todo` significa que esa persona ve lo de todos. Sin eso, cada uno ve solo lo que es para él o ella.
   - `ANTHROPIC_API_KEY` (opcional): activa la caja "Preguntale a Claude". Se saca en https://console.anthropic.com y se paga por uso. Si no la ponés, la caja muestra solo el recordatorio.
3. Volvé a **Deploys → Trigger deploy** para que tome las claves.

Para sumar o cambiar una clave, editás `CLAVES` y volvés a publicar.
