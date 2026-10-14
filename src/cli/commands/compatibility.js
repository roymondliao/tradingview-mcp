import { register } from '../router.js';
import { checkCompatibility } from '../../core/compatibility/check.js';
import { CoreOperationError } from '../../core/errors.js';
import { compatibilityStatus } from '../../core/compatibility/advisory.js';
register('compatibility', {
  desktop_dependency: 'compatibility',
  description: 'Desktop compatibility status and explicit checks',
  subcommands: new Map([
    ['check', {
      description: 'Explicit Desktop contract check; read-only by default',
      options: {
        profile: {type:'string', description:'read-only (default; compatibility never performs mutations)'},
        fixture: {type:'string', description:'Compatibility resource configuration JSON'},
        'desktop-version': {type:'string', description:'Explicit version only when CDP lacks a Desktop token'},
        output: {type:'string', short:'o', description:'Additional JSON report copy'},
        force: {type:'boolean', description:'Replace an existing output copy'},
      },
      handler: async (opts, positionals) => {
        const allowed=['profile','fixture','desktop-version','output','force'];
        if(positionals.length||Object.keys(opts).some(k=>!allowed.includes(k)))throw new CoreOperationError('Unknown compatibility check argument.',{code:'COMPATIBILITY_ARGUMENT_INVALID',kind:'validation',phase:'request_validation'});
        const controller=new AbortController();
        const interrupt=signal=>()=>controller.abort(new CoreOperationError('Compatibility check interrupted.',{code:'COMPATIBILITY_INTERRUPTED',kind:'interrupt',phase:'compatibility',signal,exit_code:signal==='SIGINT'?130:143}));
        const sigint=interrupt('SIGINT'),sigterm=interrupt('SIGTERM');
        process.once('SIGINT',sigint);process.once('SIGTERM',sigterm);
        try {return await checkCompatibility({profile:opts.profile,fixture:opts.fixture,desktop_version:opts['desktop-version'],output:opts.output,force:opts.force,signal:controller.signal});}
        finally{process.off('SIGINT',sigint);process.off('SIGTERM',sigterm);}
      },
    }],
    ['status', { description: 'Read local compatibility state (does not contact Desktop)', handler: () => compatibilityStatus() }],
  ]),
});
