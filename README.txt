NEXA POS Wi‑Fi · v9
=================

Qué es
------
- POS local (LAN/Wi‑Fi) con roles: Admin / Mozo / Cocina / Cliente.
- Menú público para clientes (sin contraseñas) + botón “Pedir la cuenta”.
- Plano de mesas + estados en vivo (PC), comandas, caja, reportes básicos.
- Panel admin con QRs listos para imprimir.

Instalar y arrancar
-------------------
1) Ejecutá INSTALAR.bat (instala dependencias de Node).
2) Ejecutá INICIAR.bat (levanta el servidor).
3) Abrí el Panel Admin: /panel.html (pide contraseña de admin).
   Si es la primera vez y no hay contraseña creada, entrá a /config.html y creala.

URLs importantes
----------------
- Panel Admin:            /panel.html
- Config accesos:         /config.html   (solo libre en “modo setup”)
- Mozo (operación):       /mozo.html
- Cocina (monitor):       /cocina.html
- Salón PC (plano mesas): /salon_pc.html
- Cliente (menú público): /menu.html

QRs recomendados
----------------
Entrá al Panel (/panel.html). Ahí te muestra:
- QR Cliente → /menu.html
- QR Mozo    → /login.html?role=mozo&next=/mozo.html

Cliente: “Pedir la cuenta”
--------------------------
En /menu.html hay un bloque “Pedir la cuenta”.
Eso NO da permisos ni muestra caja/ventas: solo envía una solicitud al staff.
Los mozos lo ven en /mozo.html (contador de solicitudes + aviso).

Seguridad (importante)
----------------------
- El menú público NO requiere contraseña.
- El servidor NO envía el estado completo (caja/ventas) por WebSocket a clientes.
  Solo mozo/admin reciben el “state” completo.

