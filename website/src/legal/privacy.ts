import type { LegalDoc } from './types';

const en: LegalDoc = {
  title: 'Privacy Policy',
  updated: 'Last updated: November 6, 2026',
  intro: [
    'This policy explains, in general terms, how Pith handles personal information when you use the Pith website or the Pith app. It is written for people anywhere in the world.',
    'Where you live may give you extra privacy rights. This policy does not take those rights away.',
  ],
  sections: [
    {
      title: 'Information we handle',
      paragraphs: ['Depending on how you use Pith, we handle:'],
      bullets: [
        'Account details from Google when you sign in, such as your name, email address, and profile photo.',
        'Meeting content: sound from your microphone and from other apps, the transcript, the summary, notes you type, titles, and workspace names.',
        'Questions you ask about your notes, and files you attach to those questions.',
        'Plan and payment status, and a customer reference from the payment provider. We do not store your full card number.',
        'Email addresses you enter when you send a summary to someone.',
        'A sign-in cookie on the website, and a sign-in token stored on your computer by the app.',
      ],
    },
    {
      title: 'How we use it',
      paragraphs: [
        'We use this information to run the notepad, turn meeting sound into text and a summary, keep your account, bill for a paid plan, send a summary when you ask us to, protect the service, and fix failures.',
        'We do not sell your personal information. We do not share it for advertising across other companies’ sites or apps.',
      ],
    },
    {
      title: 'Audio',
      paragraphs: [
        'Sound is processed so Pith can make a transcript and a summary. Pith is designed not to keep that audio after processing finishes, and not to keep unsent audio after you quit the app. Pith does not record your screen and does not save video.',
        'The transcript and the summary are kept with your note until you delete them or delete your account.',
      ],
    },
    {
      title: 'Who receives it',
      paragraphs: ['We share personal information only as needed:'],
      bullets: [
        'With providers that host Pith, sign you in, transcribe and summarize, take payment, or deliver email.',
        'With people you choose when you send a summary.',
        'With authorities when the law requires it, or when it is needed to protect Pith, our users, or others.',
      ],
    },
    {
      title: 'Other countries',
      paragraphs: [
        'Pith and its providers may process information in countries other than the one where you live. Those countries may have different privacy laws. Where a law requires a safeguard for that transfer, we use a safeguard that law accepts.',
      ],
    },
    {
      title: 'How long we keep it',
      paragraphs: [
        'We keep account information and notes while your account is open. Meeting audio is not the stored record of a meeting. If you delete a note or your account, we delete the related content from the active service.',
        'We may keep a short-lived copy in backups, and we may keep what we need for security, billing, or a legal duty. We keep that only as long as the reason lasts.',
      ],
    },
    {
      title: 'Your choices and rights',
      paragraphs: [
        'You can edit or delete notes in the app, and you can delete your account. Depending on where you live, you may also have a right to access, correct, delete, or receive a copy of your personal information, to object to or limit certain uses, to withdraw consent, and to complain to a local privacy authority.',
        'We will not treat you worse for using a privacy right. To make a request, use the contact method published on this website or in the app. We may need to confirm that the request comes from you. Some information may remain where the law requires us to keep it.',
      ],
    },
    {
      title: 'Children',
      paragraphs: [
        'Pith is not directed at children. We do not knowingly collect personal information from a child who is under the age, where they live, at which they can consent to this kind of service. If we learn that we have, we will delete it.',
      ],
    },
    {
      title: 'Security',
      paragraphs: [
        'We use reasonable measures to protect personal information. No way of storing or sending information is completely secure, and we cannot promise absolute security.',
      ],
    },
    {
      title: 'Cookies',
      paragraphs: [
        'The website uses a cookie so you can stay signed in. It is not used to advertise to you. The app stores a sign-in token on your computer for the same purpose.',
      ],
    },
    {
      title: 'Changes',
      paragraphs: [
        'We may update this policy. The date at the top of this page will change. Where the law where you live requires notice or consent, we will follow that law.',
      ],
    },
    {
      title: 'Contact',
      paragraphs: [
        'Privacy questions can be sent through the contact method published on this website or in the app.',
      ],
    },
  ],
};

const es: LegalDoc = {
  title: 'Política de privacidad',
  updated: 'Última actualización: 6 de noviembre de 2026',
  intro: [
    'Esta política explica, en términos generales, cómo Pith trata la información personal cuando usas el sitio web o la aplicación de Pith. Está escrita para personas en cualquier lugar del mundo.',
    'El lugar donde vives puede darte derechos de privacidad adicionales. Esta política no quita esos derechos.',
  ],
  sections: [
    {
      title: 'Información que tratamos',
      paragraphs: ['Según cómo uses Pith, tratamos:'],
      bullets: [
        'Datos de la cuenta de Google cuando entras, como tu nombre, correo electrónico y foto de perfil.',
        'Contenido de la reunión: sonido de tu micrófono y de otras apps, la transcripción, el resumen, las notas que escribes, los títulos y los nombres de las carpetas.',
        'Preguntas que haces sobre tus notas y los archivos que adjuntas a esas preguntas.',
        'El plan, el estado del pago y una referencia de cliente del proveedor de pagos. No guardamos el número completo de tu tarjeta.',
        'Las direcciones de correo que escribes cuando envías un resumen a alguien.',
        'Una cookie de sesión en el sitio web y un token de sesión que la aplicación guarda en tu computadora.',
      ],
    },
    {
      title: 'Cómo la usamos',
      paragraphs: [
        'Usamos esta información para operar el bloc de notas, convertir el sonido de la reunión en texto y en un resumen, mantener tu cuenta, cobrar un plan de pago, enviar un resumen cuando tú lo pides, proteger el servicio y corregir fallos.',
        'No vendemos tu información personal. No la compartimos para publicidad en sitios o apps de otras empresas.',
      ],
    },
    {
      title: 'Audio',
      paragraphs: [
        'El sonido se procesa para que Pith pueda hacer una transcripción y un resumen. Pith está diseñado para no conservar ese audio cuando termina el procesamiento, y para no conservar el audio no enviado cuando cierras la aplicación. Pith no graba tu pantalla y no guarda video.',
        'La transcripción y el resumen se conservan con tu nota hasta que los eliminas o eliminas tu cuenta.',
      ],
    },
    {
      title: 'Quién la recibe',
      paragraphs: ['Compartimos información personal solo cuando hace falta:'],
      bullets: [
        'Con proveedores que alojan Pith, te identifican, transcriben y resumen, cobran el pago o envían correo.',
        'Con las personas que tú eliges cuando envías un resumen.',
        'Con autoridades cuando la ley lo exige, o cuando hace falta para proteger a Pith, a nuestros usuarios o a otras personas.',
      ],
    },
    {
      title: 'Otros países',
      paragraphs: [
        'Pith y sus proveedores pueden tratar información en países distintos de aquel donde vives. Esos países pueden tener leyes de privacidad diferentes. Cuando una ley exige una garantía para esa transferencia, usamos una garantía que esa ley acepta.',
      ],
    },
    {
      title: 'Cuánto tiempo la conservamos',
      paragraphs: [
        'Conservamos la información de la cuenta y las notas mientras tu cuenta está abierta. El audio de la reunión no es el registro guardado de la reunión. Si eliminas una nota o tu cuenta, eliminamos el contenido relacionado del servicio activo.',
        'Podemos conservar una copia de corta duración en copias de seguridad, y lo que necesitemos por seguridad, facturación o un deber legal. Lo conservamos solo mientras dure ese motivo.',
      ],
    },
    {
      title: 'Tus opciones y derechos',
      paragraphs: [
        'Puedes editar o eliminar notas en la aplicación, y puedes eliminar tu cuenta. Según el lugar donde vives, también puedes tener derecho a acceder, corregir, eliminar o recibir una copia de tu información personal, a oponerte a ciertos usos o limitarlos, a retirar el consentimiento y a reclamar ante una autoridad local de privacidad.',
        'No te trataremos peor por usar un derecho de privacidad. Para hacer una solicitud, usa el medio de contacto publicado en este sitio web o en la aplicación. Puede que necesitemos confirmar que la solicitud es tuya. Parte de la información puede permanecer cuando la ley nos obliga a conservarla.',
      ],
    },
    {
      title: 'Menores',
      paragraphs: [
        'Pith no está dirigido a menores. No recopilamos a sabiendas información personal de un menor que no tenga, en el lugar donde vive, la edad para consentir este tipo de servicio. Si nos enteramos de que lo hicimos, la eliminaremos.',
      ],
    },
    {
      title: 'Seguridad',
      paragraphs: [
        'Usamos medidas razonables para proteger la información personal. Ninguna forma de guardar o enviar información es completamente segura, y no podemos prometer una seguridad absoluta.',
      ],
    },
    {
      title: 'Cookies',
      paragraphs: [
        'El sitio web usa una cookie para que puedas seguir con la sesión iniciada. No se usa para hacerte publicidad. La aplicación guarda un token de sesión en tu computadora con el mismo fin.',
      ],
    },
    {
      title: 'Cambios',
      paragraphs: [
        'Podemos actualizar esta política. Cambiará la fecha al inicio de esta página. Cuando la ley del lugar donde vives exija un aviso o tu consentimiento, seguiremos esa ley.',
      ],
    },
    {
      title: 'Contacto',
      paragraphs: [
        'Las preguntas de privacidad pueden enviarse por el medio de contacto publicado en este sitio web o en la aplicación.',
      ],
    },
  ],
};

export const privacy = { en, es };
