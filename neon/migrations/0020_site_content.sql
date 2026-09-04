-- Contenido editable de las páginas públicas de marketing (por ahora solo
-- dalfistudio.com) -- un documento JSON por sitio, sin historial, igual que el
-- resto del esquema de este proyecto: la edición sobrescribe, no versiona. Ver
-- getSiteContent/saveSiteContent en server/store.mjs y GET/PUT /api/site-content/:siteKey en
-- server/app.mjs. El panel de administración vive en el ERP (sebensuiteconnect.dalfistudio.com), gateado por
-- canManageConfiguration -- ver functions/api/_lib/authz.js.
create table if not exists app.site_content (
  site_key text primary key,
  content jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by text
);

-- Semilla con el contenido real que ya está publicado hoy en outputs/dalfistudionails/index.html,
-- para que activar el panel no borre nada -- el sitio sigue mostrando exactamente lo mismo hasta
-- que alguien lo edite desde el ERP.
insert into app.site_content (site_key, content, updated_by)
values (
  'dalfistudionails',
  '{
    "hero": {
      "kicker": "Baní · Peravia, República Dominicana",
      "headline": "El cuidado de tus manos,",
      "headlineAccent": "hecho con calma.",
      "lede": "Manicura, pedicura, uñas esculpidas y nail art en un espacio pensado para el detalle — sin prisa, con productos de calidad y manos que saben lo que hacen.",
      "metaItems": [
        { "value": "6+", "label": "servicios especializados" },
        { "value": "1", "label": "estudio en el centro de Baní" },
        { "value": "&", "label": "academia de formación" }
      ]
    },
    "about": {
      "paragraphs": [
        "En Dalfi Studio Nails realzamos la belleza natural de tus manos y pies — con su salud, cuidado y bienestar siempre primero. Diez años haciendo esto con calma, sin atajos, son los que nos enseñaron a hacerlo con excelencia.",
        "Nos especializamos en manicura y pedicura profesional, y en técnicas pensadas para fortalecer, proteger y conservar la integridad de la uña natural. Trabajamos con productos de alta calidad y procedimientos cuidados, para unas manos y pies más sanos, resistentes y bien atendidos.",
        "Esa misma pasión nos llevó a crear Dalfina Guzmán Academy, un espacio de formación para profesionales del oficio — técnicas actuales, conocimiento real y práctica, para que otras manicuristas perfeccionen su trabajo y eleven la calidad de sus servicios."
      ],
      "addressCaption": "Calle Duarte No. 60, esq. Beller · Baní, Peravia",
      "quote": "“Dalfi Studio Nails & Dalfina Guzmán Academy: belleza, educación, profesionalismo y compromiso con la excelencia.”"
    },
    "final": {
      "headline": "“Reserva tu momento — nosotras nos encargamos del resto.”",
      "text": "Elige el servicio, el día y la hora que mejor te queden. La confirmación y el recordatorio te llegan directo por WhatsApp."
    },
    "services": [
      { "title": "Manicura clásica", "description": "Limado, cutícula y esmaltado tradicional — la base de siempre, bien hecha.", "note": "Servicio express" },
      { "title": "Manicura en gel / semipermanente", "description": "Color de larga duración y acabado espejo, sin sacrificar la salud de la uña.", "note": "Dura más" },
      { "title": "Uñas acrílicas / esculpidas", "description": "Extensión y forma a la medida de tu mano, lista para lo que tú diseñes encima.", "note": "A medida" },
      { "title": "Pedicura spa", "description": "Exfoliación, hidratación profunda y esmaltado — el descanso que los pies también piden.", "note": "Incluye masaje" },
      { "title": "Nail art", "description": "Diseños personalizados, de lo minimalista a lo elaborado — tú traes la idea o la inspiración.", "note": "Se cotiza aparte" },
      { "title": "Dalfina Guzmán Academy", "description": "Formación para quienes quieren convertir esto en oficio — grupos pequeños, práctica real.", "note": "Cupos limitados" }
    ],
    "gallery": {
      "intro": "Esta sección la iremos llenando con fotos reales del salón, el trabajo del equipo y el día a día — por ahora, una muestra de la paleta con la que trabajamos.",
      "items": [
        { "label": "Musgo", "tag": "clásico", "color": "#B7BDA9", "comingSoon": false },
        { "label": "Lino", "tag": "neutro", "color": "#E7DEC8", "comingSoon": false },
        { "label": "Arena", "tag": "cálido", "color": "#DCC8B8", "comingSoon": false },
        { "label": "Foto próximamente", "tag": "equipo", "color": null, "comingSoon": true },
        { "label": "Salvia", "tag": "firma", "color": "#8B9481", "comingSoon": false },
        { "label": "Terracota suave", "tag": "temporada", "color": "#C79B8B", "comingSoon": false },
        { "label": "Foto próximamente", "tag": "trabajos", "color": null, "comingSoon": true },
        { "label": "Bosque", "tag": "noche", "color": "#4B5040", "comingSoon": false }
      ]
    },
    "contact": {
      "addressLine1": "Calle Duarte No. 60, esquina Beller",
      "addressLine2": "Baní, Peravia, República Dominicana",
      "whatsapp": "18093463030",
      "whatsappDisplay": "+1 (809) 346-3030",
      "instagramHandle": "dalfistudionails",
      "horario": "Se confirma directamente al reservar tu cita.",
      "mapLabel": "Centro de Baní",
      "mapText": "A pasos de la esquina Duarte con Beller — mapa interactivo próximamente."
    }
  }'::jsonb,
  'migration_0020_seed'
)
on conflict (site_key) do nothing;
