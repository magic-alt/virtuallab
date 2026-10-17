import {describe,it,expect} from 'vitest';
import {parseProfileDocument,newProfile} from './profileModel';
describe('Profile documents',()=>{
  it('round trips full configuration with Unicode argv and adapter metadata',()=>{
    const p=newProfile();p.name='编译';p.gates[0].executor={type:'adapter',adapter:'hil',action:'probe',parameters:{mode:'未知'}};
    expect(parseProfileDocument(JSON.stringify(p))).toEqual(p);
  });
  it('bounds UTF-8 bytes before parsing and rejects null and executable code',()=>{
    expect(()=>parseProfileDocument('中'.repeat(22000))).toThrow(/64 KiB/);
    expect(()=>parseProfileDocument('null')).toThrow();
  });
});
