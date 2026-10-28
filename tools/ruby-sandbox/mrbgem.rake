require 'json'
MRuby::Gem::Specification.new('niao-ruby-sandbox') do |spec|
  spec.license = 'MIT'
  spec.author = 'Niao contributors'
  spec.summary = 'Capability-free bounded Ruby evaluator for Niao'
  target = File.join(build.build_dir, 'bin', 'niao-ruby.js')
  directory File.dirname(target)
  file target => [File.join(build.build_dir, 'lib/libmruby.a'), File.dirname(target)] do |t|
    sh 'emcc', '-Oz', '-sMODULARIZE=1', '-sEXPORT_ES6=1', '-sENVIRONMENT=worker',
      '-sFILESYSTEM=0', '-sDYNAMIC_EXECUTION=0', '-sSUPPORT_LONGJMP=wasm', '-sWASM_LEGACY_EXCEPTIONS=0',
      '-sALLOW_MEMORY_GROWTH=0', '-sINITIAL_MEMORY=32MB', '-sSTACK_SIZE=1MB', '-sSTACK_OVERFLOW_CHECK=2',
      '-sEXPORTED_FUNCTIONS=["_niao_eval","_niao_reason","_niao_count","_niao_result_len","_malloc","_free"]',
      '-sEXPORTED_RUNTIME_METHODS=["HEAPU8","UTF8ToString"]',
      '-sINCOMING_MODULE_JS_API=["instantiateWasm","print","printErr"]',
      '--no-entry', t.prerequisites.first, '-o', t.name
  end
  build.bins << 'niao-ruby.js'
end
